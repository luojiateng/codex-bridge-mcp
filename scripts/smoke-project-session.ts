import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexClientPool } from "../src/codex/codexAppServerClient.js";
import type { BridgeConfig } from "../src/config/config.js";
import { DiffService } from "../src/review/diffService.js";
import { RuntimeHostManager } from "../src/runtime/runtimeHostManager.js";
import {
  TuiWindowManager,
  type TuiProcessController,
} from "../src/runtime/tuiWindowManager.js";
import { JsonlLogger } from "../src/storage/jsonlLogger.js";
import { type RuntimeHostRecord, SqliteStore } from "../src/storage/sqlite.js";
import { canonicalizeProjectRoot } from "../src/shared/projectRoot.js";
import { ProjectSessionCoordinator } from "../src/task/projectSessionCoordinator.js";
import { TaskService } from "../src/task/taskService.js";

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-project-session-"));
const projectRoot = path.join(tempDir, "project");
await fs.mkdir(projectRoot, { recursive: true });
const canonicalProjectRoot = canonicalizeProjectRoot(projectRoot).projectRoot;

let threadStartCount = 0;
let turnStartCount = 0;
const messages: RpcMessage[] = [];
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
  appServerClientName: "codex_bridge_project_session_smoke",
  appServerClientTitle: "Codex Bridge Project Session Smoke",
  appServerClientVersion: "0.1.0",
  codexModel: null,
  codexReasoningEffort: null,
  codexReasoningSummary: null,
  codexVerbosity: null,
  codexServiceTier: null,
  codexTuiMode: "resume",
  runtimeHostWindow: "hidden",
};

const alivePids = new Set<number>();
let nextPid = 9_000;
let tuiLaunchCount = 0;
let failNextTuiLaunch = false;
const launchTui = async (): Promise<number> => {
  tuiLaunchCount += 1;
  if (failNextTuiLaunch) {
    failNextTuiLaunch = false;
    throw new Error("simulated TUI launch failure");
  }
  const pid = nextPid++;
  alivePids.add(pid);
  return pid;
};
const processController: TuiProcessController = {
  isAlive: (pid) => pid !== null && alivePids.has(pid),
  terminate: (pid) => {
    alivePids.delete(pid);
  },
};

const primary = createServices();
const secondary = createServices();
await Promise.all([
  primary.taskService.waitForStartupRecovery(),
  secondary.taskService.waitForStartupRecovery(),
]);

const runtime: RuntimeHostRecord = {
  id: "runtime_project_session_smoke",
  projectRoot: canonicalProjectRoot,
  port: address.port,
  endpoint,
  pid: 1234,
  windowTitle: "CodexRuntimeHost - project-session-smoke",
  status: "RUNNING",
  startedAt: "2026-07-13T00:00:00.000Z",
  lastHeartbeatAt: "2026-07-13T00:00:00.000Z",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};
primary.store.saveRuntime(runtime);

const [first, concurrent] = await Promise.all([
  primary.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "Project Session Smoke",
    requirements: "keep one thread",
    acceptanceCriteria: [],
  }),
  secondary.taskService.openTask({
    projectRoot: `${canonicalProjectRoot}${path.sep}`,
    title: "Concurrent Follow-up",
    requirements: "must reuse",
    acceptanceCriteria: [],
  }),
]);
assert.equal(first.taskId, concurrent.taskId);
assert.equal(first.codexThreadId, concurrent.codexThreadId);
assert.equal(first.projectSessionId, concurrent.projectSessionId);
assert.deepEqual([first.status, concurrent.status].sort(), ["opened", "reused"]);
assert.equal(threadStartCount, 1);
assert.equal(tuiLaunchCount, 1);

const restarted = createServices();
await restarted.taskService.waitForStartupRecovery();
const afterRestart = await restarted.taskService.openTask({
  projectRoot: path.join(canonicalProjectRoot, "."),
  title: "After MCP Restart",
  requirements: "must still reuse",
  acceptanceCriteria: [],
});
assert.equal(afterRestart.status, "reused");
assert.equal(afterRestart.taskId, first.taskId);
assert.equal(afterRestart.codexThreadId, first.codexThreadId);
assert.equal(threadStartCount, 1);
assert.equal(tuiLaunchCount, 1);

alivePids.delete(afterRestart.codexTui.pid ?? -1);
const followUp = await restarted.taskService.sendTask({
  taskId: afterRestart.taskId,
  instruction: "Continue visibly on the same thread.",
});
assert.equal(tuiLaunchCount, 2);
assert.equal(turnStartCount, 1);
const completedTurn = restarted.store.getTurnByCodexTurnId(followUp.turnId);
assert(completedTurn);
restarted.store.saveTurn({
  ...completedTurn,
  status: "completed",
  updatedAt: new Date().toISOString(),
});

const isolated = await restarted.taskService.openTask({
  projectRoot: canonicalProjectRoot,
  title: "Explicit Isolated Session",
  requirements: "new thread was explicitly requested",
  acceptanceCriteria: [],
  mode: "new",
});
assert.equal(isolated.status, "opened");
assert.notEqual(isolated.taskId, first.taskId);
assert.notEqual(isolated.codexThreadId, first.codexThreadId);
assert.equal(threadStartCount, 2);
assert.equal(tuiLaunchCount, 3);
assert.equal(alivePids.size, 1);

alivePids.delete(isolated.codexTui.pid ?? -1);
failNextTuiLaunch = true;
await assert.rejects(
  restarted.taskService.sendTask({
    taskId: isolated.taskId,
    instruction: "This turn must not start without a visible TUI.",
  }),
  /Codex TUI is required before task_send: simulated TUI launch failure/,
);
assert.equal(turnStartCount, 1);

for (const services of [primary, secondary, restarted]) {
  services.clientPool.drop(endpoint);
  services.store.close();
}
await new Promise<void>((resolve) => wss.close(() => resolve()));
await new Promise<void>((resolve) => httpServer.close(() => resolve()));
console.log("Project session smoke test passed.");

function createServices(): {
  store: SqliteStore;
  clientPool: CodexClientPool;
  taskService: TaskService;
} {
  const store = new SqliteStore(config.dbPath);
  const logger = new JsonlLogger(config.logsDir);
  const clientPool = new CodexClientPool(config);
  const tuiWindowManager = new TuiWindowManager(
    store,
    config,
    launchTui,
    processController,
  );
  const runtimeHostManager = new RuntimeHostManager(
    store,
    logger,
    clientPool,
    config,
    tuiWindowManager,
  );
  const taskService = new TaskService(
    store,
    runtimeHostManager,
    clientPool,
    logger,
    new DiffService(config),
    config,
    new ProjectSessionCoordinator(store),
    tuiWindowManager,
  );
  return { store, clientPool, taskService };
}

function handleClientMessage(socket: WebSocket, message: RpcMessage): void {
  if (message.id === undefined || !message.method) {
    return;
  }
  if (message.method === "initialize") {
    respond(socket, message.id, {
      userAgent: "codex-bridge-project-session-smoke",
      codexHome: tempDir,
      platformFamily: "windows",
      platformOs: "windows",
    });
    return;
  }
  if (message.method === "thread/start") {
    threadStartCount += 1;
    respond(socket, message.id, { thread: { id: `thread_project_session_${threadStartCount}` } });
    return;
  }
  if (message.method === "thread/resume") {
    respond(socket, message.id, {
      thread: { id: String(message.params?.threadId ?? "thread_project_session_unknown") },
    });
    return;
  }
  if (message.method === "turn/start") {
    turnStartCount += 1;
    respond(socket, message.id, { turn: { id: `turn_project_session_${turnStartCount}` } });
    return;
  }
  respond(socket, message.id, {});
}

function respond(socket: WebSocket, id: string | number, result: unknown): void {
  socket.send(JSON.stringify({ id, result }));
}
