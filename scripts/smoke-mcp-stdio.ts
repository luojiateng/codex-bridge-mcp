import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SqliteStore,
  type TaskRecord,
  type TurnRecord,
} from "../src/storage/sqlite.js";

interface CoreHealth {
  service: string;
  status: string;
  pid: number;
  protocolVersion: number;
  buildId: string;
}

interface AttentionToolPayload {
  status: string;
  attention: { revision: number };
}

interface ReplayToolPayload {
  replayed: boolean;
  replayReason: string;
  nextAction: string;
  requiredAckRevision?: number;
}

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const entrypoint = path.join(projectRoot, "dist", "index.js");
await fs.access(entrypoint);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-mcp-stdio-"));
const port = await reservePort();
const endpoint = `http://127.0.0.1:${port}/mcp`;
const childEnv = {
  ...stringEnv(),
  CODEX_BRIDGE_DATA_DIR: path.join(tempDir, "data"),
  CODEX_BRIDGE_HTTP_PORT: String(port),
  CODEX_BRIDGE_CODEX_TUI_MODE: "off",
  CODEX_BRIDGE_CORE_START_TIMEOUT_MS: "10000",
  CODEX_BRIDGE_ATTENTION_HEARTBEAT_MS: "1000",
};
const first = createClient("first");
const second = createClient("second");
let corePid: number | null = null;
let seedStore: SqliteStore | null = null;

try {
  await Promise.all([
    first.connect(createTransport(childEnv)),
    second.connect(createTransport(childEnv)),
  ]);
  const expected = [
    "approval_decide",
    "task_await",
    "task_compact",
    "task_diff",
    "task_events",
    "task_list",
    "task_open",
    "task_recover",
    "task_send",
    "task_status",
  ];
  const [firstTools, secondTools] = await Promise.all([first.listTools(), second.listTools()]);
  assert.deepEqual(firstTools.tools.map((tool) => tool.name).sort(), expected);
  assert.deepEqual(secondTools.tools.map((tool) => tool.name).sort(), expected);
  assert.match(first.getInstructions() ?? "", /durable active session/);

  const initialHealth = await readHealth(endpoint);
  assert.equal(initialHealth.service, "codex-bridge-mcp");
  assert.equal(initialHealth.status, "READY");
  assert.equal(initialHealth.protocolVersion, 2);
  assert.ok(initialHealth.buildId.length > 0);
  corePid = initialHealth.pid;

  const timestamp = new Date().toISOString();
  const task: TaskRecord = {
    id: "task_stdio_attention",
    title: "stdio attention delivery",
    projectRoot: path.join(tempDir, "project"),
    runtimeHostId: "runtime_stdio_attention",
    codexThreadId: "thread_stdio_attention",
    codexThreadName: "stdio attention delivery",
    status: "running",
    requirements: null,
    acceptanceCriteria: [],
    tokenBudget: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const turn: TurnRecord = {
    id: "turn_stdio_attention",
    taskId: task.id,
    codexThreadId: task.codexThreadId,
    codexTurnId: "codex_turn_stdio_attention",
    status: "running",
    instruction: "wait for durable completion",
    attentionRevision: 0,
    attentionAckRevision: 0,
    attentionKind: null,
    attentionPayload: null,
    result: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  seedStore = new SqliteStore(path.join(childEnv.CODEX_BRIDGE_DATA_DIR, "bridge.db"));
  seedStore.saveTask(task);
  seedStore.saveTurn(turn);

  const progressUpdates: Array<{ progress: number; message?: string }> = [];
  const attentionPromise = second.callTool(
    {
      name: "task_await",
      arguments: { taskId: task.id, turnId: turn.codexTurnId, afterRevision: 0 },
    },
    undefined,
    {
      timeout: 5_000,
      onprogress: (progress) => progressUpdates.push(progress),
    },
  );
  await delay(1_200);
  seedStore.recordTurnAttention({
    taskId: task.id,
    codexTurnId: turn.codexTurnId,
    turnStatus: "completed",
    taskStatus: "waiting_review",
    attentionKind: "completed",
    attentionPayload: {
      type: "codex_turn_completed",
      status: "completed",
      nextAction: "task_diff",
    },
  });
  const attention = parseToolJson<AttentionToolPayload>(await attentionPromise);
  assert.equal(attention.status, "completed");
  assert.equal(attention.attention.revision, 1);
  assert(progressUpdates.length >= 2, "Core progress heartbeats must cross HTTP and stdio");

  const replay = parseToolJson<ReplayToolPayload>(
    await second.callTool({
      name: "task_send",
      arguments: { taskId: task.id, instruction: "must not start a new turn", runChecks: false },
    }),
  );
  assert.equal(replay.replayed, true);
  assert.match(replay.replayReason, /No new turn was started.*follow nextAction/);
  assert.equal(replay.nextAction, "task_diff");
  assert.equal(seedStore.getLatestPendingAttention(task.id)?.attentionRevision, 1);
  seedStore.acknowledgeTurnAttention(turn.codexTurnId, 1);
  assert.equal(seedStore.getLatestPendingAttention(task.id), null);

  seedStore.saveTurn({
    ...turn,
    status: "failed",
    attentionRevision: 2,
    attentionAckRevision: 1,
    attentionKind: "failed",
    attentionPayload: { type: "turn_failed", error: "smoke failure" },
  });
  const failedReplay = parseToolJson<ReplayToolPayload>(
    await second.callTool({
      name: "task_send",
      arguments: { taskId: task.id, instruction: "continue after failure", runChecks: false },
    }),
  );
  assert.equal(failedReplay.replayed, true);
  assert.match(failedReplay.replayReason, /No new turn was started.*follow nextAction/);
  assert.equal(failedReplay.nextAction, "task_send");
  assert.equal(failedReplay.requiredAckRevision, 2);
  seedStore.acknowledgeTurnAttention(turn.codexTurnId, 2);
  assert.equal(seedStore.getLatestPendingAttention(task.id), null);
  seedStore.close();
  seedStore = null;

  await first.close();
  assert.equal((await second.listTools()).tools.length, expected.length);
  const afterDisconnect = await readHealth(endpoint);
  assert.equal(afterDisconnect.pid, corePid, "stdio disconnect must not replace the shared Core");
  assert.equal(afterDisconnect.status, "READY");

  await second.close();
  const afterAllClients = await readHealth(endpoint);
  assert.equal(afterAllClients.pid, corePid, "the shared Core must outlive all stdio adapters");
  assert.equal(afterAllClients.status, "READY");
} finally {
  await first.close().catch(() => undefined);
  await second.close().catch(() => undefined);
  seedStore?.close();
  if (corePid === null) {
    corePid = await readHealth(endpoint).then((health) => health.pid).catch(() => null);
  }
  if (corePid !== null) {
    try {
      process.kill(corePid, "SIGTERM");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "ESRCH") {
        throw error;
      }
    }
    await waitForCoreExit(endpoint);
  }
}

console.log("MCP stdio adapter and shared Core lifecycle smoke test passed.");

function createClient(suffix: string): Client {
  return new Client(
    { name: `codex-bridge-stdio-smoke-${suffix}`, version: "0.1.0" },
    { capabilities: {} },
  );
}

function createTransport(env: Record<string, string>): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: projectRoot,
    env,
    stderr: "pipe",
  });
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const reserved = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return reserved;
}

async function readHealth(endpoint: string): Promise<CoreHealth> {
  const response = await fetch(new URL("/healthz", endpoint));
  assert.equal(response.status, 200);
  return (await response.json()) as CoreHealth;
}

async function waitForCoreExit(endpoint: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(new URL("/healthz", endpoint), { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Bridge Core ${corePid ?? ""} did not exit after the smoke test.`);
}

function stringEnv(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function parseToolJson<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  const firstContent = result.content[0];
  assert(firstContent && firstContent.type === "text");
  return JSON.parse(firstContent.text) as T;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
