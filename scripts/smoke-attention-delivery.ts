import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexClientPool } from "../src/codex/codexAppServerClient.js";
import { config as defaultConfig, type BridgeConfig } from "../src/config/config.js";
import { RuntimeHostManager } from "../src/runtime/runtimeHostManager.js";
import { JsonlLogger } from "../src/storage/jsonlLogger.js";
import {
  type ApprovalRecord,
  type RuntimeHostRecord,
  type TaskRecord,
  type TurnRecord,
  SqliteStore,
} from "../src/storage/sqlite.js";
import { TaskService } from "../src/task/taskService.js";

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-attention-"));
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
const bridgeConfig: BridgeConfig = {
  ...defaultConfig,
  dataDir: path.join(tempDir, "data"),
  dbPath: path.join(tempDir, "data", "bridge.db"),
  logsDir: path.join(tempDir, "data", "logs"),
  runtimeScriptsDir: path.join(tempDir, "data", "runtime-scripts"),
  runtimeReconnectTimeoutMs: 1_000,
  codexTuiMode: "off",
};

const timestamp = "2026-07-13T00:00:00.000Z";
const runtime: RuntimeHostRecord = {
  id: "runtime_attention",
  projectRoot,
  port: address.port,
  endpoint,
  pid: 1234,
  windowTitle: "CodexRuntimeHost - attention",
  status: "RUNNING",
  startedAt: timestamp,
  lastHeartbeatAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const task: TaskRecord = {
  id: "task_attention",
  title: "Attention Delivery",
  projectRoot,
  runtimeHostId: runtime.id,
  codexThreadId: "thread_attention",
  codexThreadName: "Attention Delivery",
  status: "opened",
  requirements: null,
  acceptanceCriteria: [],
  tokenBudget: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const store = new SqliteStore(bridgeConfig.dbPath);
store.saveRuntime(runtime);
store.saveTask(task);
const logger = new JsonlLogger(bridgeConfig.logsDir);
const clientPool = new CodexClientPool(bridgeConfig);
const runtimeHostManager = new RuntimeHostManager(store, logger, clientPool, bridgeConfig);
const taskService = new TaskService(
  store,
  runtimeHostManager,
  clientPool,
  logger,
  {} as never,
  bridgeConfig,
);
await taskService.waitForStartupRecovery();

const started = await taskService.sendTask({
  taskId: task.id,
  instruction: "Perform the attention delivery smoke test.",
});
const approvalAttention = await taskService.waitForAttention({
  taskId: task.id,
  turnId: started.turnId,
  afterRevision: 0,
});

assert.equal(approvalAttention.status, "awaiting_approval");
assert.equal(approvalAttention.attention.revision, 1);
assert.equal(approvalAttention.attention.kind, "approval");
assert.equal(store.getLatestTurn(task.id)?.status, "awaiting_approval");
assert.equal(store.getTask(task.id)?.status, "awaiting_approval");
await waitFor(
  () => store.listEvents(task.id, 0, 20).filter((event) => event.eventType === "approval_requested").length === 1,
);
assert.equal(
  store.listEvents(task.id, 0, 20).filter((event) => event.eventType === "approval_requested").length,
  1,
);

const pendingApproval = store.getPendingApproval(task.id);
assert(pendingApproval);
const decisions = await Promise.allSettled([
  taskService.decideApproval({
    taskId: task.id,
    approvalId: pendingApproval.id,
    decision: "approve",
    reason: "Attention delivery smoke approval.",
  }),
  taskService.decideApproval({
    taskId: task.id,
    approvalId: pendingApproval.id,
    decision: "approve",
    reason: "Concurrent duplicate approval.",
  }),
]);
assert.equal(decisions.filter((decision) => decision.status === "fulfilled").length, 1);
assert.equal(decisions.filter((decision) => decision.status === "rejected").length, 1);
const resolvedDecision = decisions.find((decision) => decision.status === "fulfilled");
assert(resolvedDecision?.status === "fulfilled");
const resolved = resolvedDecision.value;
assert.equal(resolved.attentionRevision, 1);
assert.equal(store.getLatestTurn(task.id)?.attentionAckRevision, 1);

const completedAttention = await taskService.waitForAttention({
  taskId: task.id,
  turnId: started.turnId,
  afterRevision: resolved.attentionRevision,
});
assert.equal(completedAttention.status, "completed");
assert.equal(completedAttention.attention.revision, 2);
assert.equal(completedAttention.attention.kind, "completed");
assert.equal(store.getLatestTurn(task.id)?.attentionAckRevision, 1);
assert.equal(taskService.getPendingAttention(task.id)?.attention.revision, 2);
assert.deepEqual(completedAttention.attention.result, {
  finalMessage: "changes: smoke complete; files: none; tests: smoke; unfinished: none",
});
assert.throws(
  () => taskService.acknowledgeAttention(task.id, completedAttention.attention.revision + 1),
  /Cannot acknowledge future attention revision/,
);
assert.equal(taskService.getPendingAttention(task.id)?.attention.revision, 2);
taskService.acknowledgeAttention(task.id, completedAttention.attention.revision);
assert.equal(store.getLatestTurn(task.id)?.attentionAckRevision, 2);
assert.equal(taskService.getPendingAttention(task.id), null);

const historyTask: TaskRecord = {
  ...task,
  id: "task_attention_history",
  title: "Attention History",
  codexThreadId: "thread_attention_history",
};
const oldHistoryTurn: TurnRecord = {
  ...legacyTurnTemplate(historyTask, "turn_attention_history_old", "2026-07-12T00:00:00.000Z"),
  status: "completed",
  attentionRevision: 1,
  attentionAckRevision: 0,
  attentionKind: "completed",
};
const latestHistoryTurn: TurnRecord = {
  ...legacyTurnTemplate(historyTask, "turn_attention_history_latest", "2026-07-13T00:00:00.000Z"),
  status: "completed",
  attentionRevision: 1,
  attentionAckRevision: 1,
  attentionKind: "completed",
};
store.saveTask(historyTask);
store.saveTurn(oldHistoryTurn);
store.saveTurn(latestHistoryTurn);
assert.equal(
  store.getLatestPendingAttention(historyTask.id),
  null,
  "Acknowledging the latest turn must not replay older turn attention",
);
assert.equal(
  store
    .listEvents(task.id, 0, 200)
    .some((event) => event.eventType.includes("delta")),
  false,
  "Raw Codex deltas must not be persisted as Bridge audit events",
);

const turnStart = messages.find((message) => message.method === "turn/start");
const turnText = String(
  (turnStart?.params?.input as Array<Record<string, unknown>> | undefined)?.[0]?.text ?? "",
);
assert.doesNotMatch(turnText, /report\.json|JSON self-report|data[\\/]logs[\\/]tasks/i);
assert.equal(
  messages.filter(
    (message) =>
      message.id === "approval-attention" &&
      JSON.stringify(message.result) === JSON.stringify({ decision: "accept" }),
  ).length,
  1,
);

const legacyTask: TaskRecord = {
  ...task,
  id: "task_attention_legacy",
  title: "Legacy Pending Approval",
  codexThreadId: "thread_attention_legacy",
  status: "running",
};
const legacyTurn: TurnRecord = {
  id: "turn_attention_legacy",
  taskId: legacyTask.id,
  codexThreadId: legacyTask.codexThreadId,
  codexTurnId: "codex_turn_attention_legacy",
  status: "running",
  instruction: "Legacy pending turn",
  attentionRevision: 0,
  attentionAckRevision: 0,
  attentionKind: null,
  attentionPayload: null,
  result: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const legacyApproval: ApprovalRecord = {
  id: "approval_attention_legacy",
  taskId: legacyTask.id,
  runtimeHostId: runtime.id,
  codexThreadId: legacyTask.codexThreadId,
  codexTurnId: legacyTurn.codexTurnId,
  codexRequestId: "approval-request-attention-legacy",
  kind: "item/commandExecution/requestApproval",
  command: "npm test",
  cwd: projectRoot,
  reason: "Legacy pending approval",
  riskSummary: null,
  payload: {},
  decision: null,
  decidedBy: null,
  decisionReason: null,
  createdAt: timestamp,
  resolvedAt: null,
};
store.saveTask(legacyTask);
store.saveTurn(legacyTurn);
store.saveApproval(legacyApproval);

clientPool.drop(endpoint);
store.close();
const reopenedStore = new SqliteStore(bridgeConfig.dbPath);
assert.equal(reopenedStore.getLatestTurn(legacyTask.id)?.status, "awaiting_approval");
assert.equal(reopenedStore.getLatestTurn(legacyTask.id)?.attentionRevision, 1);
assert.equal(reopenedStore.getLatestTurn(legacyTask.id)?.attentionAckRevision, 0);
assert.equal(reopenedStore.getLatestTurn(legacyTask.id)?.attentionKind, "approval");
assert.equal(reopenedStore.getTask(legacyTask.id)?.status, "awaiting_approval");
reopenedStore.close();

const restartedStore = new SqliteStore(bridgeConfig.dbPath);
const restartedPool = new CodexClientPool(bridgeConfig);
const restartedLogger = new JsonlLogger(bridgeConfig.logsDir);
const restartedRuntimeManager = new RuntimeHostManager(
  restartedStore,
  restartedLogger,
  restartedPool,
  bridgeConfig,
);
const restartedTaskService = new TaskService(
  restartedStore,
  restartedRuntimeManager,
  restartedPool,
  restartedLogger,
  {} as never,
  bridgeConfig,
);
await restartedTaskService.start();
assert.equal(restartedStore.getApproval(legacyApproval.id)?.decision, "orphaned");
assert.equal(restartedStore.getLatestTurn(legacyTask.id)?.status, "interrupted");
assert.equal(restartedStore.getLatestTurn(legacyTask.id)?.attentionKind, "interrupted");
assert.equal(
  restartedStore
    .listEvents(legacyTask.id, 0, 50)
    .filter((event) => event.eventType === "approval_orphaned").length,
  1,
);
restartedTaskService.stop();
restartedPool.closeAll();
restartedStore.close();
for (const socket of wss.clients) {
  socket.terminate();
}
await new Promise<void>((resolve) => wss.close(() => resolve()));
await new Promise<void>((resolve) => httpServer.close(() => resolve()));
console.log("Attention delivery smoke test passed.");

function handleClientMessage(socket: WebSocket, message: RpcMessage): void {
  if (message.id === "approval-attention" && message.result) {
    socket.send(
      JSON.stringify({
        method: "serverRequest/resolved",
        params: { threadId: task.codexThreadId, requestId: message.id },
      }),
    );
    setTimeout(() => {
      for (let index = 0; index < 100; index += 1) {
        socket.send(
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              threadId: task.codexThreadId,
              turnId: "turn_attention",
              itemId: "agent_message_attention",
              delta: `noise-${index}`,
            },
          }),
        );
      }
      socket.send(
        JSON.stringify({
          method: "item/completed",
          params: {
            threadId: task.codexThreadId,
            turnId: "turn_attention",
            item: {
              type: "agentMessage",
              id: "agent_message_attention",
              text: "changes: smoke complete; files: none; tests: smoke; unfinished: none",
              phase: "final_answer",
              memoryCitation: null,
            },
            completedAtMs: Date.now(),
          },
        }),
      );
      socket.send(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: task.codexThreadId,
            turn: {
              id: "turn_attention",
              items: [],
              itemsView: "full",
              status: "completed",
              error: null,
            },
          },
        }),
      );
    }, 10);
    return;
  }
  if (message.id === undefined || !message.method) {
    return;
  }
  if (message.method === "initialize") {
    respond(socket, message.id, {
      userAgent: "codex-bridge-attention-smoke",
      codexHome: tempDir,
      platformFamily: "windows",
      platformOs: "windows",
    });
    return;
  }
  if (message.method === "thread/resume") {
    respond(socket, message.id, { thread: { id: task.codexThreadId } });
    return;
  }
  if (message.method === "turn/start") {
    respond(socket, message.id, { turn: { id: "turn_attention" } });
    queueMicrotask(() => {
      const request = {
        id: "approval-attention",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: task.codexThreadId,
          turnId: "turn_attention",
          itemId: "command_attention",
          command: "npm test",
          cwd: projectRoot,
          reason: "Attention delivery smoke request.",
        },
      };
      socket.send(JSON.stringify(request));
      socket.send(JSON.stringify(request));
    });
    return;
  }
  respond(socket, message.id, {});
}

function respond(socket: WebSocket, id: string | number, result: unknown): void {
  socket.send(JSON.stringify({ id, result }));
}

function legacyTurnTemplate(
  taskRecord: TaskRecord,
  codexTurnId: string,
  timestampValue: string,
): TurnRecord {
  return {
    id: codexTurnId,
    taskId: taskRecord.id,
    codexThreadId: taskRecord.codexThreadId,
    codexTurnId,
    status: "running",
    instruction: null,
    attentionRevision: 0,
    attentionAckRevision: 0,
    attentionKind: null,
    attentionPayload: null,
    result: null,
    createdAt: timestampValue,
    updatedAt: timestampValue,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for attention smoke state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
