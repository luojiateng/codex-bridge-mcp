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
import { TuiWindowManager } from "../src/runtime/tuiWindowManager.js";
import { canonicalizeProjectRoot } from "../src/shared/projectRoot.js";
import { JsonlLogger } from "../src/storage/jsonlLogger.js";
import {
  type ApprovalRecord,
  type RuntimeHostRecord,
  type TaskRecord,
  type TurnRecord,
  SqliteStore,
} from "../src/storage/sqlite.js";
import { ProjectSessionCoordinator } from "../src/task/projectSessionCoordinator.js";
import { TaskService } from "../src/task/taskService.js";

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-interruption-"));
const targetProjectDir = path.join(tempDir, "target-project");
const otherProjectDir = path.join(tempDir, "other-project");
await fs.mkdir(targetProjectDir, { recursive: true });
await fs.mkdir(otherProjectDir, { recursive: true });
const targetProjectRoot = canonicalizeProjectRoot(targetProjectDir).projectRoot;
const otherProjectRoot = canonicalizeProjectRoot(otherProjectDir).projectRoot;

let readinessChecks = 0;
const messages: RpcMessage[] = [];
const httpServer = http.createServer((request, response) => {
  if (request.url === "/readyz") {
    readinessChecks += 1;
    response.writeHead(readinessChecks <= 3 ? 503 : 200);
    response.end(readinessChecks <= 3 ? "not ready" : "ok");
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
const bridgeConfig: BridgeConfig = {
  ...defaultConfig,
  dataDir: path.join(tempDir, "data"),
  dbPath: path.join(tempDir, "data", "bridge.db"),
  logsDir: path.join(tempDir, "data", "logs"),
  runtimeScriptsDir: path.join(tempDir, "data", "runtime-scripts"),
  runtimeReconnectTimeoutMs: 100,
  codexTuiMode: "remote",
};

const store = new SqliteStore(bridgeConfig.dbPath);
const logger = new JsonlLogger(bridgeConfig.logsDir);
const clientPool = new CodexClientPool(bridgeConfig);
const aliveTuiPids = new Set<number>();
let nextTuiPid = 9_900;
let tuiLaunchCount = 0;
const launchTuiStub = async (): Promise<number> => {
  tuiLaunchCount += 1;
  const pid = nextTuiPid++;
  aliveTuiPids.add(pid);
  return pid;
};
const tuiWindowManager = new TuiWindowManager(store, bridgeConfig, launchTuiStub, {
  isAlive: (pid) => pid !== null && aliveTuiPids.has(pid),
  terminate: (pid) => {
    aliveTuiPids.delete(pid);
  },
});
const runtimeHostManager = new RuntimeHostManager(
  store,
  logger,
  clientPool,
  bridgeConfig,
  tuiWindowManager,
);
const timestamp = "2026-07-12T00:00:00.000Z";
const targetRuntime: RuntimeHostRecord = {
  id: "runtime_interruption_target",
  projectRoot: targetProjectRoot,
  port: address.port,
  endpoint,
  pid: 1234,
  windowTitle: "CodexRuntimeHost - interruption-target",
  status: "RUNNING",
  startedAt: timestamp,
  lastHeartbeatAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const otherRuntime: RuntimeHostRecord = {
  ...targetRuntime,
  id: "runtime_interruption_other",
  projectRoot: otherProjectRoot,
  windowTitle: "CodexRuntimeHost - interruption-other",
};
const targetTask: TaskRecord = {
  id: "task_interruption_target",
  title: "Interruption Target",
  projectRoot: targetProjectRoot,
  runtimeHostId: targetRuntime.id,
  codexThreadId: "thread_interruption_target",
  codexThreadName: "Interruption Target",
  status: "running",
  requirements: null,
  acceptanceCriteria: [],
  tokenBudget: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const otherTask: TaskRecord = {
  ...targetTask,
  id: "task_interruption_other",
  title: "Interruption Other",
  projectRoot: otherProjectRoot,
  runtimeHostId: otherRuntime.id,
  codexThreadId: "thread_interruption_other",
  codexThreadName: "Interruption Other",
};
const targetTurn: TurnRecord = {
  id: "turn_interruption_target",
  taskId: targetTask.id,
  codexThreadId: targetTask.codexThreadId,
  codexTurnId: "codex_turn_interruption_target",
  status: "running",
  instruction: "Stuck target turn",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const otherTurn: TurnRecord = {
  ...targetTurn,
  id: "turn_interruption_other",
  taskId: otherTask.id,
  codexThreadId: otherTask.codexThreadId,
  codexTurnId: "codex_turn_interruption_other",
};
const targetApproval: ApprovalRecord = {
  id: "approval_interruption_target",
  taskId: targetTask.id,
  runtimeHostId: targetRuntime.id,
  codexThreadId: targetTask.codexThreadId,
  codexTurnId: targetTurn.codexTurnId,
  codexRequestId: "approval_request_interruption_target",
  kind: "command_execution",
  command: "npm run build",
  cwd: targetProjectRoot,
  reason: "Pending target approval",
  riskSummary: "Smoke test approval",
  payload: {},
  decision: null,
  decidedBy: null,
  decisionReason: null,
  createdAt: timestamp,
  resolvedAt: null,
};
const otherApproval: ApprovalRecord = {
  ...targetApproval,
  id: "approval_interruption_other",
  taskId: otherTask.id,
  runtimeHostId: otherRuntime.id,
  codexThreadId: otherTask.codexThreadId,
  codexTurnId: otherTurn.codexTurnId,
  codexRequestId: "approval_request_interruption_other",
  cwd: otherProjectRoot,
  reason: "Pending other approval",
};

store.saveRuntime(targetRuntime);
store.saveRuntime(otherRuntime);
store.saveTask(targetTask);
store.saveTask(otherTask);
const targetSession = store.activateProjectSessionForTask(targetTask);
store.saveTurn(targetTurn);
store.saveTurn(otherTurn);
store.saveApproval(targetApproval);
store.saveApproval(otherApproval);
store.enqueueCommand("queue_interruption_target", targetTask.id, "Stuck target command");
store.markCommandStarted("queue_interruption_target");
store.enqueueCommand("queue_interruption_other", otherTask.id, "Active other command");
store.markCommandStarted("queue_interruption_other");

const runtimeHostManagerInternals = runtimeHostManager as unknown as {
  startRuntimeHost(
    projectRoot: string,
    previousRuntimeId: string | undefined,
  ): Promise<RuntimeHostRecord>;
};
runtimeHostManagerInternals.startRuntimeHost = async (projectRoot, previousRuntimeId) => {
  assert.equal(projectRoot, targetProjectRoot);
  assert.equal(previousRuntimeId, targetRuntime.id);
  const recreated = {
    ...targetRuntime,
    status: "RUNNING" as const,
    updatedAt: new Date().toISOString(),
  };
  store.saveRuntime(recreated);
  return recreated;
};

const tuiInput = {
  sessionId: targetSession.id,
  sessionGeneration: targetSession.generation,
  runtimeId: targetRuntime.id,
  projectRoot: targetProjectRoot,
  endpoint,
  threadId: targetTask.codexThreadId,
};
const initialTuiLaunch = await tuiWindowManager.ensure(tuiInput);
assert.equal(initialTuiLaunch.launched, true);
const cachedTuiLaunch = await tuiWindowManager.ensure(tuiInput);
assert.equal(cachedTuiLaunch.launched, false);
assert.equal(tuiLaunchCount, 1);

const recoveredRuntime = await runtimeHostManager.ensureExistingRuntime(targetRuntime.id);
assert.equal(recoveredRuntime.status, "RUNNING");
assert.equal(readinessChecks, 3);
const recoveredSession = store.getProjectSessionById(targetSession.id);
assert(recoveredSession);
assert.equal(recoveredSession.generation, targetSession.generation + 1);
const relaunchedTui = await tuiWindowManager.ensure({
  ...tuiInput,
  sessionGeneration: recoveredSession.generation,
});
assert.equal(relaunchedTui.launched, true);
assert.equal(tuiLaunchCount, 2);
assert.equal(store.getLatestTurn(targetTask.id)?.status, "interrupted");
assert.equal(store.getTask(targetTask.id)?.status, "interrupted");
assert.equal(store.getQueueSnapshot(targetTask.id).running, 0);
assert.equal(store.getQueueSnapshot(targetTask.id).interrupted, 1);
assert.equal(store.getLatestTurn(otherTask.id)?.status, "running");
assert.equal(store.getTask(otherTask.id)?.status, "running");
assert.equal(store.getQueueSnapshot(otherTask.id).running, 1);
assert.equal(store.getQueueSnapshot(otherTask.id).interrupted, 0);
const interruptedApproval = store.getApproval(targetApproval.id);
assert.equal(interruptedApproval?.decision, "orphaned");
assert.equal(interruptedApproval?.decidedBy, "bridge");
assert.equal(
  interruptedApproval?.decisionReason,
  "Approval was orphaned because its Runtime Host connection was lost; it cannot be answered on a replacement connection.",
);
assert.notEqual(interruptedApproval?.resolvedAt, null);
assert.equal(store.getPendingApproval(targetTask.id), null);
assert.equal(store.getApproval(otherApproval.id)?.decision, null);
assert.equal(store.getPendingApproval(otherTask.id)?.id, otherApproval.id);
const targetEvents = store.listEvents(targetTask.id, 0, 20);
assert.equal(targetEvents.some((event) => event.eventType === "codex_turn_interrupted"), true);
assert.equal(targetEvents.some((event) => event.eventType === "task_command_interrupted"), true);
const approvalEvent = targetEvents.find((event) => event.eventType === "approval_orphaned");
assert(approvalEvent);
const approvalEventPayload = approvalEvent.payload as Record<string, unknown>;
assert.equal(approvalEventPayload.approvalId, targetApproval.id);
assert.equal(approvalEventPayload.decision, "orphaned");
assert.equal(approvalEventPayload.nextAction, "task_status");
assert.equal(store.listEvents(otherTask.id, 0, 20).length, 0);

const taskService = new TaskService(
  store,
  runtimeHostManager,
  clientPool,
  logger,
  {} as never,
  bridgeConfig,
  new ProjectSessionCoordinator(store),
  tuiWindowManager,
);
await taskService.waitForStartupRecovery();
const summarizedEvents = await taskService.events({
  taskId: targetTask.id,
  afterSeq: 0,
  limit: 20,
  markDelivered: false,
  includePayload: false,
});
const approvalSummary = summarizedEvents.events.find(
  (event) => event.eventType === "approval_orphaned",
);
assert(approvalSummary && "summary" in approvalSummary);
assert.equal(
  approvalSummary.summary,
  "A pending approval was orphaned after its Runtime Host connection was lost.",
);
assert.equal(approvalSummary.nextAction, "task_status");
assert.deepEqual(approvalSummary.details, {
  approvalId: targetApproval.id,
  decision: "orphaned",
  decidedBy: "bridge",
  decisionReason:
    "Approval was orphaned because its Runtime Host connection was lost; it cannot be answered on a replacement connection.",
  resolvedAt: interruptedApproval?.resolvedAt,
});
const interruptedAttention = taskService.getPendingAttention(targetTask.id);
assert.equal(interruptedAttention?.attention.kind, "interrupted");
const sessionBeforeSend = store.getProjectSessionByKey(
  canonicalizeProjectRoot(targetTask.projectRoot).projectKey,
);
assert(sessionBeforeSend);
const tuiBeforeSend = store.getTuiInstance(sessionBeforeSend.id);
assert.equal(tuiBeforeSend?.status, "RUNNING");
assert.equal(tuiBeforeSend?.pid, relaunchedTui.pid);
assert(relaunchedTui.pid !== null && aliveTuiPids.has(relaunchedTui.pid));
assert.equal(tuiBeforeSend?.generation, sessionBeforeSend.generation);
assert.equal(tuiBeforeSend?.runtimeEndpoint, recoveredRuntime.endpoint);
assert.equal(tuiBeforeSend?.codexThreadId, targetTask.codexThreadId);
const started = await taskService.sendTask({
  taskId: targetTask.id,
  instruction: "Continue after automatic recovery.",
  ackRevision: interruptedAttention?.attention.revision,
});
assert.equal(started.turnId, "turn_after_interruption");
assert.equal(store.getLatestTurn(targetTask.id)?.status, "running");
assert.equal(store.getLatestTurn(targetTask.id)?.codexTurnId, "turn_after_interruption");
assert.equal(store.getLatestTurn(otherTask.id)?.status, "running");
assert.equal(store.getQueueSnapshot(otherTask.id).running, 1);
assert.equal(messages.some((message) => message.method === "thread/resume"), true);
assert.equal(messages.some((message) => message.method === "turn/start"), true);

taskService.stop();
clientPool.drop(endpoint);
store.close();
for (const socket of wss.clients) {
  socket.terminate();
}
await new Promise<void>((resolve) => wss.close(() => resolve()));
await new Promise<void>((resolve) => httpServer.close(() => resolve()));
console.log("Runtime interruption smoke test passed.");

function handleClientMessage(socket: WebSocket, message: RpcMessage): void {
  if (message.id === undefined || !message.method) {
    return;
  }
  if (message.method === "initialize") {
    respond(socket, message.id, {
      userAgent: "codex-bridge-interruption-smoke",
      codexHome: tempDir,
      platformFamily: "windows",
      platformOs: "windows",
    });
    return;
  }
  if (message.method === "thread/resume") {
    respond(socket, message.id, { thread: { id: targetTask.codexThreadId } });
    return;
  }
  if (message.method === "turn/start") {
    respond(socket, message.id, { turn: { id: "turn_after_interruption" } });
    return;
  }
  respond(socket, message.id, {});
}

function respond(socket: WebSocket, id: string | number, result: unknown): void {
  socket.send(JSON.stringify({ id, result }));
}
