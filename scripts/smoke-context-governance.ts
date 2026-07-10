import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexNotification } from "../src/codex/codexProtocol.js";
import type { RuntimeHostRecord, TaskRecord } from "../src/storage/sqlite.js";
import { JsonlLogger } from "../src/storage/jsonlLogger.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { TaskService } from "../src/task/taskService.js";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-context-"));
const store = new SqliteStore(path.join(tempDir, "bridge.db"));
const logger = new JsonlLogger(path.join(tempDir, "logs"));

const taskService = new TaskService(
  store,
  {} as never,
  {} as never,
  logger,
  {} as never,
);

const runtime: RuntimeHostRecord = {
  id: "runtime_test",
  projectRoot: tempDir,
  port: 4510,
  endpoint: "ws://127.0.0.1:4510",
  pid: null,
  windowTitle: "CodexRuntimeHost - smoke",
  status: "RUNNING",
  startedAt: "2026-07-08T00:00:00.000Z",
  lastHeartbeatAt: "2026-07-08T00:00:00.000Z",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

const task: TaskRecord = {
  id: "task_context_smoke",
  title: "Context Smoke",
  projectRoot: tempDir,
  runtimeHostId: runtime.id,
  codexThreadId: "thread_context_smoke",
  codexThreadName: "Context Smoke",
  status: "running",
  requirements: null,
  acceptanceCriteria: [],
  tokenBudget: null,
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

store.saveRuntime(runtime);
store.saveTask(task);

const privateTaskService = taskService as unknown as {
  handleNotification: (runtime: RuntimeHostRecord, notification: CodexNotification) => Promise<void>;
};

await privateTaskService.handleNotification(runtime, tokenUsageNotification(700));
const warningStatus = await taskService.status(task.id);
assert.deepEqual((warningStatus.context as Record<string, unknown>)?.warning, true);
assert.deepEqual((warningStatus.context as Record<string, unknown>)?.nearLimit, false);

await privateTaskService.handleNotification(runtime, tokenUsageNotification(860));
await privateTaskService.handleNotification(runtime, tokenUsageNotification(900));

const usage = store.getContextUsage(task.id);
assert.equal(usage?.totalTokens, 900);
assert.equal(usage?.contextPercent, 90);
assert.equal(usage?.nearLimitEmitted, true);

const events = store.listEvents(task.id, 0, 20);
assert.equal(events.filter((event) => event.eventType === "context_near_limit").length, 1);
assert.equal(events.some((event) => event.eventType === "codex_thread_token_usage_updated"), true);

const summarized = await taskService.events({
  taskId: task.id,
  afterSeq: 0,
  markDelivered: false,
});
const summarizedTokenEvent = summarized.events.find(
  (event) => event.eventType === "codex_thread_token_usage_updated",
) as Record<string, unknown>;
assert.equal("payload" in summarizedTokenEvent, false);
assert.equal(typeof summarizedTokenEvent.summary, "string");

const full = await taskService.events({
  taskId: task.id,
  afterSeq: 0,
  markDelivered: false,
  includePayload: true,
});
assert.equal("payload" in (full.events[0] as Record<string, unknown>), true);

store.close();
console.log("Context governance smoke test passed.");

function tokenUsageNotification(totalTokens: number): CodexNotification {
  return {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: task.codexThreadId,
      turnId: "turn_context_smoke",
      tokenUsage: {
        total: {
          totalTokens,
          inputTokens: totalTokens - 100,
          cachedInputTokens: 0,
          outputTokens: 100,
          reasoningOutputTokens: 10,
        },
        last: {
          totalTokens: 100,
          inputTokens: 80,
          cachedInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 5,
        },
        modelContextWindow: 1000,
      },
    },
  };
}
