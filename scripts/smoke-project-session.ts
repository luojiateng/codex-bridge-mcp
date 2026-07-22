import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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

const legacyDbPath = path.join(tempDir, "legacy-v3.db");
const legacyDb = new Database(legacyDbPath);
legacyDb.pragma("user_version = 3");
legacyDb.close();
const migratedStore = new SqliteStore(legacyDbPath);
assert.deepEqual(
  migratedStore.getOrchestratorBinding({ kind: "claude", sessionId: "not-yet-bound" }),
  null,
);
migratedStore.close();
const migratedDb = new Database(legacyDbPath, { readonly: true });
assert.equal(migratedDb.pragma("user_version", { simple: true }), 4);
assert.deepEqual(
  migratedDb
    .prepare(
      "select count(*) as count from sqlite_master where type = 'table' and name = 'orchestrator_session_binding'",
    )
    .get(),
  { count: 1 },
);
migratedDb.close();

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
  codexTuiAutoRelaunch: "active-turn",
  runtimeHostWindow: "hidden",
};

const alivePids = new Set<number>();
let nextPid = 9_000;
let tuiLaunchCount = 0;
let tuiFailuresRemaining = 0;
const launchTui = async (): Promise<number> => {
  tuiLaunchCount += 1;
  if (tuiFailuresRemaining > 0) {
    tuiFailuresRemaining -= 1;
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
const orchestratorA = { kind: "claude" as const, sessionId: "claude-session-a" };
const orchestratorB = { kind: "claude" as const, sessionId: "claude-session-b" };
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

await assert.rejects(
  primary.taskService.openTask({
    projectRoot: path.join(tempDir, "missing-project-session"),
    title: "Missing expected task must not create",
    requirements: "restore an existing task only",
    acceptanceCriteria: [],
    expectedTaskId: "missing_task_id",
  }),
  /expectedTaskId=missing_task_id is not the active task.*task_list or task_recover/,
);
assert.equal(threadStartCount, 0);
assert.equal(tuiLaunchCount, 0);

const [first, concurrent] = await Promise.all([
  primary.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "Project Session Smoke",
    requirements: "keep one thread",
    acceptanceCriteria: ["stay on the existing task thread"],
    orchestrator: orchestratorA,
  }),
  secondary.taskService.openTask({
    projectRoot: `${canonicalProjectRoot}${path.sep}`,
    title: "Project Session Smoke",
    requirements: "keep one thread",
    acceptanceCriteria: ["stay on the existing task thread"],
    orchestrator: orchestratorA,
  }),
]);
assert.equal(first.taskId, concurrent.taskId);
assert.equal(first.codexThreadId, concurrent.codexThreadId);
assert.equal(first.projectSessionId, concurrent.projectSessionId);
assert.deepEqual([first.status, concurrent.status].sort(), ["opened", "reused"]);
assert.equal(threadStartCount, 1);
assert.equal(tuiLaunchCount, 1);
assert.equal(first.title, "Project Session Smoke");
assert.equal(concurrent.requestedTitle, "Project Session Smoke");
assert.equal(first.orchestratorBinding?.kind, orchestratorA.kind);
assert.equal(first.orchestratorBinding?.sessionId, orchestratorA.sessionId);
assert.equal(first.orchestratorBinding?.id, concurrent.orchestratorBinding?.id);
const threadStartMessage = messages.find((message) => message.method === "thread/start");
const threadDeveloperInstructions = String(
  threadStartMessage?.params?.developerInstructions ?? "",
);
assert.match(threadDeveloperInstructions, new RegExp(`Task ID: ${first.taskId}`));
assert.match(threadDeveloperInstructions, /Title: Project Session Smoke/);
assert.match(threadDeveloperInstructions, /Requirements:\nkeep one thread/);
assert.match(threadDeveloperInstructions, /- stay on the existing task thread/);
await assert.rejects(
  primary.taskService.openTask({
    projectRoot: path.join(tempDir, "another-project"),
    title: "One Claude conversation cannot switch projects",
    requirements: "preserve the original binding",
    acceptanceCriteria: [],
    orchestrator: orchestratorA,
  }),
  new RegExp(`already bound to task ${first.taskId}.*one orchestrator session cannot bind another project`),
);
await assert.rejects(
  primary.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "Unrelated task must not silently reuse",
    requirements: "different work",
    acceptanceCriteria: [],
  }),
  new RegExp(`active task ${first.taskId} is bound to orchestrator session claude:claude-session-a`),
);
await assert.rejects(
  primary.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "Project Session Smoke",
    requirements: "keep one thread",
    acceptanceCriteria: ["stay on the existing task thread"],
  }),
  new RegExp(`active task ${first.taskId} is bound to orchestrator session claude:claude-session-a`),
);
const legacyExplicitReuse = await primary.taskService.openTask({
  projectRoot: canonicalProjectRoot,
  title: "Legacy explicit reuse",
  requirements: "legacy client already knows the task",
  acceptanceCriteria: [],
  expectedTaskId: first.taskId,
});
assert.equal(legacyExplicitReuse.taskId, first.taskId);
assert.equal(legacyExplicitReuse.orchestratorBinding?.id, first.orchestratorBinding?.id);
await assert.rejects(
  primary.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "A different Claude session must not reuse this Codex session",
    requirements: "reject cross-session reuse",
    acceptanceCriteria: [],
    expectedTaskId: first.taskId,
    orchestrator: orchestratorB,
  }),
  new RegExp(
    `active task ${first.taskId} belongs to orchestrator session claude:claude-session-a`,
  ),
);
await assert.rejects(
  primary.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "Project Session Smoke",
    requirements: "keep one thread",
    acceptanceCriteria: ["stay on the existing task thread"],
    expectedTaskId: "wrong_task_id",
    orchestrator: orchestratorA,
  }),
  new RegExp(`bound to task ${first.taskId}, not expectedTaskId=wrong_task_id`),
);
await assert.rejects(
  primary.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "Same Claude session cannot create a second Codex session",
    requirements: "preserve one-to-one binding",
    acceptanceCriteria: [],
    mode: "new",
    orchestrator: orchestratorA,
  }),
  new RegExp(`already bound to task ${first.taskId}.*instead of opening mode=new`),
);
await assert.rejects(
  primary.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "Invalid mixed identity request",
    requirements: "must not rotate the session",
    acceptanceCriteria: [],
    mode: "new",
    expectedTaskId: first.taskId,
  }),
  /expectedTaskId is only valid with task_open mode=reuse/,
);
assert.equal(threadStartCount, 1);
assert.equal(tuiLaunchCount, 1);
const generatedTuiScripts = (await fs.readdir(config.runtimeScriptsDir)).filter((name) =>
  name.endsWith(".tui.ps1"),
);
assert.equal(generatedTuiScripts.length, 1);
const generatedTuiScript = await fs.readFile(
  path.join(config.runtimeScriptsDir, generatedTuiScripts[0]),
  "utf8",
);
assert.match(generatedTuiScript, /while \(\$true\)/);
assert.match(generatedTuiScript, /Add-Content -LiteralPath \$TuiLogPath/);
assert.match(generatedTuiScript, /Attempt \$\(\$attempt\):/);
assert.match(
  generatedTuiScript,
  /Set-Content -LiteralPath '.*\.tui\.pid' -Value \$PID -Encoding ASCII -ErrorAction Stop/,
);

const restarted = createServices();
await restarted.taskService.waitForStartupRecovery();
const afterRestart = await restarted.taskService.openTask({
  projectRoot: path.join(canonicalProjectRoot, "."),
  title: "After MCP Restart",
  requirements: "must still reuse",
  acceptanceCriteria: [],
  orchestrator: orchestratorA,
});
assert.equal(afterRestart.status, "reused");
assert.equal(afterRestart.taskId, first.taskId);
assert.equal(afterRestart.codexThreadId, first.codexThreadId);
assert.equal(afterRestart.title, "Project Session Smoke");
assert.equal(afterRestart.requestedTitle, "After MCP Restart");
assert.equal(afterRestart.orchestratorBinding?.id, first.orchestratorBinding?.id);
assert.equal(threadStartCount, 1);
assert.equal(tuiLaunchCount, 1);
const resumeMessage = messages.filter((message) => message.method === "thread/resume").at(-1);
const resumeDeveloperInstructions = String(resumeMessage?.params?.developerInstructions ?? "");
assert.match(resumeDeveloperInstructions, new RegExp(`Task ID: ${first.taskId}`));
assert.match(resumeDeveloperInstructions, /Title: Project Session Smoke/);

alivePids.delete(afterRestart.codexTui.pid ?? -1);
await waitFor(
  () => restarted.store.getTuiInstance(afterRestart.projectSessionId)?.status === "EXITED",
);
assert.equal(restarted.store.getTuiInstance(afterRestart.projectSessionId)?.status, "EXITED");
assert.equal(tuiLaunchCount, 1);
assert.equal(turnStartCount, 0);

const followUp = await restarted.taskService.sendTask({
  taskId: afterRestart.taskId,
  instruction: "Restore the idle TUI, then continue visibly on the same thread.",
});
assert.equal(tuiLaunchCount, 2);
assert.equal(turnStartCount, 1);
const turnStartMessage = messages.filter((message) => message.method === "turn/start").at(-1);
const turnInput = turnStartMessage?.params?.input as Array<{ text?: string }> | undefined;
const sentInstruction = turnInput?.[0]?.text ?? "";
assert.match(sentInstruction, /Restore the idle TUI, then continue visibly on the same thread\./);
assert.doesNotMatch(sentInstruction, /Authoritative durable task contract/);
assert.doesNotMatch(sentInstruction, /Task ID:/);
assert.doesNotMatch(sentInstruction, /Requirements:/);
assert.equal(
  restarted.store.getTuiInstance(afterRestart.projectSessionId)?.status,
  "RUNNING",
);

const rehydrated = createServices();
await rehydrated.taskService.waitForStartupRecovery();
for (const services of [primary, secondary, restarted]) {
  services.taskService.stop();
}

const activeTui = rehydrated.store.getTuiInstance(afterRestart.projectSessionId);
assert(activeTui?.pid);
alivePids.delete(activeTui.pid);
await waitFor(() => tuiLaunchCount === 3);
await waitFor(
  () => rehydrated.store.getTuiInstance(afterRestart.projectSessionId)?.status === "RUNNING",
);
assert.equal(turnStartCount, 1);

const relaunchedTui = rehydrated.store.getTuiInstance(afterRestart.projectSessionId);
assert(relaunchedTui?.pid);
tuiFailuresRemaining = 2;
alivePids.delete(relaunchedTui.pid);
await waitFor(
  () => {
    const instance = rehydrated.store.getTuiInstance(afterRestart.projectSessionId);
    return instance?.status === "FAILED" && instance.restartAttempts === 3;
  },
);
const circuitStatus = await rehydrated.taskService.status(afterRestart.taskId);
assert.deepEqual(circuitStatus.codexTui, {
  mode: "resume",
  autoRelaunch: "active-turn",
  projectSessionId: afterRestart.projectSessionId,
  sessionGeneration: afterRestart.sessionGeneration,
  status: "FAILED",
  pid: null,
  restartAttempts: 3,
  nextRestartAt: null,
  lastExitAt: rehydrated.store.getTuiInstance(afterRestart.projectSessionId)?.lastExitAt,
  lastError: rehydrated.store.getTuiInstance(afterRestart.projectSessionId)?.lastError,
});

const restored = await rehydrated.taskService.openTask({
  projectRoot: canonicalProjectRoot,
  title: "Reset the TUI relaunch circuit",
  requirements: "reuse the existing task and restore its TUI",
  acceptanceCriteria: [],
  orchestrator: orchestratorA,
});
assert.equal(tuiLaunchCount, 6);
assert(restored.codexTui.pid !== null && alivePids.has(restored.codexTui.pid));
assert.equal(rehydrated.store.getTuiInstance(afterRestart.projectSessionId)?.restartAttempts, 0);

const completedTurn = rehydrated.store.getTurnByCodexTurnId(followUp.turnId);
assert(completedTurn);
rehydrated.store.saveTurn({
  ...completedTurn,
  status: "completed",
  updatedAt: new Date().toISOString(),
});

const runningBeforeTerminationFailure = rehydrated.store.getTuiInstance(
  afterRestart.projectSessionId,
);
assert(runningBeforeTerminationFailure?.pid);
const launchCountBeforeTerminationFailure = tuiLaunchCount;
const terminationFailureManager = new TuiWindowManager(rehydrated.store, config, launchTui, {
  isAlive: processController.isAlive,
  terminate: () => {
    throw new Error("simulated process-tree termination failure");
  },
});
await assert.rejects(
  terminationFailureManager.ensure({
    runtimeId: runtime.id,
    projectRoot: canonicalProjectRoot,
    endpoint,
    threadId: "thread_replacement_must_not_launch",
    sessionId: afterRestart.projectSessionId,
    sessionGeneration: 2,
  }),
  /simulated process-tree termination failure/,
);
assert.equal(tuiLaunchCount, launchCountBeforeTerminationFailure);
assert.equal(
  rehydrated.store.getTuiInstance(afterRestart.projectSessionId)?.pid,
  runningBeforeTerminationFailure.pid,
);
assert.equal(rehydrated.store.getTuiInstance(afterRestart.projectSessionId)?.status, "RUNNING");

const isolated = await rehydrated.taskService.openTask({
  projectRoot: canonicalProjectRoot,
  title: "Explicit Isolated Session",
  requirements: "new thread was explicitly requested",
  acceptanceCriteria: [],
  mode: "new",
  orchestrator: orchestratorB,
});
assert.equal(isolated.status, "opened");
assert.notEqual(isolated.taskId, first.taskId);
assert.notEqual(isolated.codexThreadId, first.codexThreadId);
assert.equal(threadStartCount, 2);
assert.equal(tuiLaunchCount, 7);
assert.equal(alivePids.size, 1);
assert.equal(isolated.orchestratorBinding?.sessionId, orchestratorB.sessionId);
assert.notEqual(isolated.orchestratorBinding?.id, first.orchestratorBinding?.id);
assert.equal(
  rehydrated.store.getOrchestratorBinding(orchestratorA)?.taskId,
  first.taskId,
);
assert.equal(
  rehydrated.store.getOrchestratorBinding(orchestratorB)?.taskId,
  isolated.taskId,
);
await assert.rejects(
  rehydrated.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "Restore the first Claude conversation",
    requirements: "must select its own Codex session",
    acceptanceCriteria: [],
    orchestrator: orchestratorA,
  }),
  new RegExp(
    `remains bound to task ${first.taskId}.*active task is ${isolated.taskId}.*task_recover with taskId=${first.taskId}`,
  ),
);
assert.equal(threadStartCount, 2);
assert.equal(tuiLaunchCount, 7);

alivePids.delete(isolated.codexTui.pid ?? -1);
tuiFailuresRemaining = 1;
await assert.rejects(
  rehydrated.taskService.openTask({
    projectRoot: canonicalProjectRoot,
    title: "Failed visible session restore",
    requirements: "surface the launch failure",
    acceptanceCriteria: [],
    orchestrator: orchestratorB,
  }),
  /Codex TUI is required for the project session: simulated TUI launch failure/,
);
assert.equal(tuiLaunchCount, 8);
assert.equal(turnStartCount, 1);

const disabledRelaunchManager = new TuiWindowManager(
  rehydrated.store,
  { ...config, codexTuiAutoRelaunch: "off" },
  launchTui,
  processController,
);
await assert.rejects(
  disabledRelaunchManager.ensure(
    {
      runtimeId: runtime.id,
      projectRoot: canonicalProjectRoot,
      endpoint,
      threadId: isolated.codexThreadId,
      sessionId: isolated.projectSessionId,
      sessionGeneration: isolated.sessionGeneration,
    },
    { trigger: "task_send" },
  ),
  /automatic relaunch is disabled.*task_open with mode=reuse and expectedTaskId/,
);
assert.equal(tuiLaunchCount, 8);

const activeSessionRelaunchManager = new TuiWindowManager(
  rehydrated.store,
  { ...config, codexTuiAutoRelaunch: "active-session" },
  launchTui,
  processController,
  {
    startupGraceMs: 5,
    monitorIntervalMs: 10,
    restartWindowMs: 5_000,
    stableRuntimeMs: 5_000,
    restartBackoffMs: [0, 20, 40],
  },
);
await activeSessionRelaunchManager.start();
await waitFor(() => tuiLaunchCount === 9);
await waitFor(
  () => rehydrated.store.getTuiInstance(isolated.projectSessionId)?.status === "RUNNING",
);
assert.equal(turnStartCount, 1);
activeSessionRelaunchManager.stop();

for (const services of [primary, secondary, restarted, rehydrated]) {
  services.taskService.stop();
  services.clientPool.drop(endpoint);
  services.store.close();
}
await new Promise<void>((resolve) => wss.close(() => resolve()));
await new Promise<void>((resolve) => httpServer.close(() => resolve()));
console.log("Project session smoke test passed.");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for project-session smoke state.`);
    }
    await delay(10);
  }
}

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
    {
      startupGraceMs: 5,
      monitorIntervalMs: 10,
      restartWindowMs: 5_000,
      stableRuntimeMs: 5_000,
      restartBackoffMs: [0, 20, 40],
    },
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
