import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexClientPool } from "../src/codex/codexAppServerClient.js";
import type { BridgeConfig } from "../src/config/config.js";
import { RuntimeHostManager } from "../src/runtime/runtimeHostManager.js";
import { JsonlLogger } from "../src/storage/jsonlLogger.js";
import {
  type RuntimeHostRecord,
  type TaskRecord,
  type TurnRecord,
  SqliteStore,
} from "../src/storage/sqlite.js";
import { RecoveryService } from "../src/task/recoveryService.js";
import { TaskService } from "../src/task/taskService.js";

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-recovery-"));
const projectRoot = path.join(tempDir, "project");
await fs.mkdir(projectRoot, { recursive: true });

const messages: RpcMessage[] = [];
let activeSocket: WebSocket | null = null;
const httpServer = http.createServer((request, response) => {
  if (request.url === "/readyz" || request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});
wss.on("connection", (socket) => {
  activeSocket = socket;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8")) as RpcMessage;
    messages.push(message);
    handleClientMessage(socket, message);
  });
});
httpServer.listen(0, "127.0.0.1");
await once(httpServer, "listening");

const address = httpServer.address();
assert(address && typeof address === "object");
const endpoint = `ws://127.0.0.1:${address.port}`;
const config: BridgeConfig = {
  dataDir: path.join(tempDir, "data"),
  dbPath: path.join(tempDir, "data", "bridge.db"),
  logsDir: path.join(tempDir, "data", "logs"),
  runtimeScriptsDir: path.join(tempDir, "data", "runtime-scripts"),
  runtimePortBase: 4510,
  runtimePortSpan: 10,
  runtimeStartTimeoutMs: 5_000,
  runtimeReconnectTimeoutMs: 1_000,
  appServerClientName: "codex_bridge_recovery_smoke",
  appServerClientTitle: "Codex Bridge Recovery Smoke",
  appServerClientVersion: "0.1.0",
  codexModel: null,
  codexReasoningEffort: null,
  codexReasoningSummary: null,
  codexVerbosity: null,
  codexServiceTier: null,
  codexTuiMode: "off",
  runtimeHostWindow: "hidden",
};

const store = new SqliteStore(config.dbPath);
const logger = new JsonlLogger(config.logsDir);
const clientPool = new CodexClientPool(config);
const runtimeHostManager = new RuntimeHostManager(store, logger, clientPool, config);

const runtime: RuntimeHostRecord = {
  id: "runtime_recovery_smoke",
  projectRoot,
  port: address.port,
  endpoint,
  pid: 1234,
  windowTitle: "CodexRuntimeHost - recovery-smoke",
  status: "RUNNING",
  startedAt: "2026-07-08T00:00:00.000Z",
  lastHeartbeatAt: "2026-07-08T00:00:00.000Z",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};
const task: TaskRecord = {
  id: "task_recovery_smoke",
  title: "Recovery Smoke",
  projectRoot,
  runtimeHostId: runtime.id,
  codexThreadId: "thread_recovery_smoke",
  codexThreadName: "Recovery Smoke",
  status: "running",
  requirements: null,
  acceptanceCriteria: [],
  tokenBudget: null,
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};
store.saveRuntime(runtime);
store.saveTask(task);
const runningTurn: TurnRecord = {
  id: "turn_recovery_smoke",
  taskId: task.id,
  codexThreadId: task.codexThreadId,
  codexTurnId: "codex_turn_recovery_smoke",
  status: "running",
  instruction: "Recover this turn",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};
store.saveTurn(runningTurn);
const taskService = new TaskService(store, runtimeHostManager, clientPool, logger, {} as never, config);
await taskService.waitForStartupRecovery();
clientPool.drop(endpoint);
const recoveryService = new RecoveryService(
  store,
  runtimeHostManager,
  clientPool,
  logger,
  config,
  (recoveredTask, recoveredRuntime, recoveredClient) =>
    taskService.bindTaskRuntimeEvents(recoveredTask, recoveredRuntime, recoveredClient),
);

const recovered = await recoveryService.recoverTask(task.id);
assert.equal(recovered.runtimeHostId, runtime.id);
assert.equal(recovered.runtimeEndpoint, endpoint);
assert.equal(recovered.codexThreadId, task.codexThreadId);
assert.equal(recovered.codexTui.launched, false);
assert.equal(recovered.codexTui.mode, "off");
assert.equal(messages.some((message) => message.method === "thread/resume"), true);
assert.equal(messages.some((message) => message.method === "thread/start"), false);
assert.equal(store.getRuntime(runtime.id)?.status, "RUNNING");
assert.equal(
  store.listEvents(task.id, 0, 20).some((event) => event.eventType === "task_recovered"),
  true,
);
assert(activeSocket);
activeSocket.send(
  JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: task.codexThreadId,
      turn: { id: runningTurn.codexTurnId, status: "completed" },
    },
  }),
);
await waitFor(() => store.getLatestTurn(task.id)?.status === "completed");
assert.equal(store.getTask(task.id)?.status, "waiting_review");

clientPool.drop(endpoint);
store.close();
await new Promise<void>((resolve) => wss.close(() => resolve()));
await new Promise<void>((resolve) => httpServer.close(() => resolve()));
console.log("Recovery smoke test passed.");

function handleClientMessage(socket: WebSocket, message: RpcMessage): void {
  if (!message.id || !message.method) {
    return;
  }
  if (message.method === "initialize") {
    respond(socket, message.id, {
      userAgent: "codex-bridge-recovery-smoke",
      codexHome: tempDir,
      platformFamily: "windows",
      platformOs: "windows",
    });
    return;
  }
  if (message.method === "thread/resume") {
    respond(socket, message.id, { thread: { id: "thread_recovery_smoke" } });
    return;
  }
  respond(socket, message.id, {});
}

function respond(socket: WebSocket, id: string | number, result: unknown): void {
  socket.send(JSON.stringify({ id, result }));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for recovered Runtime events.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
