import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { config as defaultConfig, type BridgeConfig } from "../src/config/config.js";
import { RuntimeHostManager } from "../src/runtime/runtimeHostManager.js";
import { JsonlLogger } from "../src/storage/jsonlLogger.js";
import {
  type RuntimeHostRecord,
  type TaskRecord,
  type TurnRecord,
  SqliteStore,
} from "../src/storage/sqlite.js";
import { TaskService } from "../src/task/taskService.js";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-queue-"));
const store = new SqliteStore(path.join(tempDir, "bridge.db"));
const logger = new JsonlLogger(path.join(tempDir, "logs"));
const liveServer = http.createServer((request, response) => {
  if (request.url === "/readyz") {
    response.writeHead(200);
    response.end("ok");
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
liveServer.listen(0, "127.0.0.1");
await once(liveServer, "listening");
const liveAddress = liveServer.address();
assert(liveAddress && typeof liveAddress === "object");
const bridgeConfig: BridgeConfig = {
  ...defaultConfig,
  dataDir: tempDir,
  dbPath: path.join(tempDir, "bridge.db"),
  logsDir: path.join(tempDir, "logs"),
  runtimeScriptsDir: path.join(tempDir, "runtime-scripts"),
  runtimeReconnectTimeoutMs: 100,
  codexTuiMode: "off",
};

const runtime: RuntimeHostRecord = {
  id: "runtime_queue_smoke",
  projectRoot: tempDir,
  port: 1,
  endpoint: "ws://127.0.0.1:1",
  pid: null,
  windowTitle: "CodexRuntimeHost - queue-smoke",
  status: "RUNNING",
  startedAt: "2026-07-08T00:00:00.000Z",
  lastHeartbeatAt: "2026-07-08T00:00:00.000Z",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};
const task: TaskRecord = {
  id: "task_queue_smoke",
  title: "Queue Smoke",
  projectRoot: tempDir,
  runtimeHostId: runtime.id,
  codexThreadId: "thread_queue_smoke",
  codexThreadName: "Queue Smoke",
  status: "running",
  requirements: null,
  acceptanceCriteria: [],
  tokenBudget: null,
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};
const liveRuntime: RuntimeHostRecord = {
  ...runtime,
  id: "runtime_queue_live_smoke",
  projectRoot: path.join(tempDir, "live-project"),
  port: liveAddress.port,
  endpoint: `ws://127.0.0.1:${liveAddress.port}`,
  windowTitle: "CodexRuntimeHost - queue-live-smoke",
};
const liveTask: TaskRecord = {
  ...task,
  id: "task_queue_live_smoke",
  title: "Queue Live Smoke",
  projectRoot: liveRuntime.projectRoot,
  runtimeHostId: liveRuntime.id,
  codexThreadId: "thread_queue_live_smoke",
  codexThreadName: "Queue Live Smoke",
};
const deadTurn: TurnRecord = {
  id: "turn_queue_smoke",
  taskId: task.id,
  codexThreadId: task.codexThreadId,
  codexTurnId: "codex_turn_queue_smoke",
  status: "running",
  instruction: "Interrupted turn",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};
const liveTurn: TurnRecord = {
  ...deadTurn,
  id: "turn_queue_live_smoke",
  taskId: liveTask.id,
  codexThreadId: liveTask.codexThreadId,
  codexTurnId: "codex_turn_queue_live_smoke",
};

store.saveRuntime(runtime);
store.saveRuntime(liveRuntime);
store.saveTask(task);
store.saveTask(liveTask);
store.saveTurn(deadTurn);
store.saveTurn(liveTurn);
store.enqueueCommand("queue_pending", task.id, "Pending instruction");
store.enqueueCommand("queue_running", task.id, "Interrupted instruction");
store.markCommandStarted("queue_running");
store.enqueueCommand("queue_live_running", liveTask.id, "Still running instruction");
store.markCommandStarted("queue_live_running");

const runtimeHostManager = new RuntimeHostManager(
  store,
  logger,
  {} as never,
  bridgeConfig,
);
const taskService = new TaskService(
  store,
  runtimeHostManager,
  {} as never,
  logger,
  {} as never,
  bridgeConfig,
);
await taskService.waitForStartupRecovery();
const snapshot = store.getQueueSnapshot(task.id);
assert.equal(snapshot.queued, 1);
assert.equal(snapshot.running, 0);
assert.equal(snapshot.interrupted, 1);
assert.equal(store.getLatestTurn(task.id)?.status, "interrupted");
const liveSnapshot = store.getQueueSnapshot(liveTask.id);
assert.equal(liveSnapshot.running, 1);
assert.equal(liveSnapshot.interrupted, 0);
assert.equal(store.getLatestTurn(liveTask.id)?.status, "running");

const status = await taskService.status(task.id);
assert.deepEqual((status.queue as Record<string, unknown>)?.queued, 1);
assert.deepEqual((status.queue as Record<string, unknown>)?.interrupted, 1);

const summarized = await taskService.events({
  taskId: task.id,
  afterSeq: 0,
  markDelivered: false,
});
const interrupted = summarized.events.find(
  (event) => event.eventType === "task_command_interrupted",
) as Record<string, unknown>;
assert.equal(typeof interrupted.summary, "string");
assert.equal("payload" in interrupted, false);

const full = await taskService.events({
  taskId: task.id,
  afterSeq: 0,
  markDelivered: false,
  includePayload: true,
});
assert.equal("payload" in (full.events[0] as Record<string, unknown>), true);

store.close();
await new Promise<void>((resolve) => liveServer.close(() => resolve()));
console.log("Queue recovery smoke test passed.");
