import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlLogger } from "../src/storage/jsonlLogger.js";
import { type RuntimeHostRecord, type TaskRecord, SqliteStore } from "../src/storage/sqlite.js";
import { TaskService } from "../src/task/taskService.js";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-queue-"));
const store = new SqliteStore(path.join(tempDir, "bridge.db"));
const logger = new JsonlLogger(path.join(tempDir, "logs"));

const runtime: RuntimeHostRecord = {
  id: "runtime_queue_smoke",
  projectRoot: tempDir,
  port: 4510,
  endpoint: "ws://127.0.0.1:4510",
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

store.saveRuntime(runtime);
store.saveTask(task);
store.enqueueCommand("queue_pending", task.id, "Pending instruction");
store.enqueueCommand("queue_running", task.id, "Interrupted instruction");
store.markCommandStarted("queue_running");

const taskService = new TaskService(store, {} as never, {} as never, logger, {} as never);
const snapshot = store.getQueueSnapshot(task.id);
assert.equal(snapshot.queued, 1);
assert.equal(snapshot.running, 0);
assert.equal(snapshot.interrupted, 1);

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
console.log("Queue recovery smoke test passed.");
