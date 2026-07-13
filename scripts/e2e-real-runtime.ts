import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexClientPool } from "../src/codex/codexAppServerClient.js";
import type { BridgeConfig } from "../src/config/config.js";
import { RuntimeHostManager } from "../src/runtime/runtimeHostManager.js";
import { delay } from "../src/runtime/heartbeat.js";
import { DiffService } from "../src/review/diffService.js";
import { JsonlLogger } from "../src/storage/jsonlLogger.js";
import { type ApprovalRecord, type EventRecord, SqliteStore } from "../src/storage/sqlite.js";
import { TaskService } from "../src/task/taskService.js";

const timeoutMs = Number(process.env.CODEX_BRIDGE_E2E_TIMEOUT_MS ?? 240_000);
const defaultFixtureBase =
  process.platform === "win32" ? "E:\\tmp" : os.tmpdir();
const fixtureRoot = path.resolve(
  process.env.CODEX_BRIDGE_E2E_PROJECT_ROOT ??
    path.join(defaultFixtureBase, "codex-bridge-mcp-real-e2e"),
);
const dataDir = path.join(fixtureRoot, ".codex-bridge-data");
const notesPath = path.join(fixtureRoot, "notes.txt");

const bridgeConfig: BridgeConfig = {
  dataDir,
  dbPath: path.join(dataDir, "bridge.db"),
  logsDir: path.join(dataDir, "logs"),
  runtimeScriptsDir: path.join(dataDir, "runtime-scripts"),
  runtimePortBase: Number(process.env.CODEX_BRIDGE_PORT_BASE ?? 4510),
  runtimePortSpan: Number(process.env.CODEX_BRIDGE_PORT_SPAN ?? 400),
  runtimeStartTimeoutMs: Number(process.env.CODEX_BRIDGE_RUNTIME_START_TIMEOUT_MS ?? 45_000),
  runtimeReconnectTimeoutMs: Number(process.env.CODEX_BRIDGE_RUNTIME_RECONNECT_TIMEOUT_MS ?? 3_000),
  appServerClientName: "codex_bridge_mcp_e2e",
  appServerClientTitle: "Codex Bridge MCP E2E",
  appServerClientVersion: "0.1.0",
};

await prepareFixture();

const store = new SqliteStore(bridgeConfig.dbPath);
const logger = new JsonlLogger(bridgeConfig.logsDir);
const clientPool = new CodexClientPool(bridgeConfig);
const runtimeHostManager = new RuntimeHostManager(store, logger, clientPool, bridgeConfig);
const diffService = new DiffService(bridgeConfig);
const taskService = new TaskService(
  store,
  runtimeHostManager,
  clientPool,
  logger,
  diffService,
);

const opened = await taskService.openTask({
  projectRoot: fixtureRoot,
  title: `Real Runtime E2E ${new Date().toISOString()}`,
  requirements:
    "Verify that Codex Bridge MCP uses one long-lived Codex Runtime Host and one Codex thread.",
  acceptanceCriteria: [
    "Two task_send calls keep the same runtimeHostId.",
    "Two task_send calls keep the same codexThreadId.",
    "Codex edits notes.txt inside the fixture project.",
  ],
});

console.log(`Opened task ${opened.taskId}`);
console.log(`Runtime endpoint ${opened.runtimeEndpoint}`);
console.log(`Thread ${opened.codexThreadId}`);

const first = await runTurn(
  "Append this exact line to notes.txt and do not change anything else: BRIDGE_E2E_TURN_1",
  opened.taskId,
);
const second = await runTurn(
  "Append this exact line to notes.txt and do not change anything else: BRIDGE_E2E_TURN_2",
  opened.taskId,
);

assert.equal(first.runtimeHostId, opened.runtimeHostId);
assert.equal(second.runtimeHostId, opened.runtimeHostId);
assert.equal(first.codexThreadId, opened.codexThreadId);
assert.equal(second.codexThreadId, opened.codexThreadId);

const notes = await fs.readFile(notesPath, "utf8");
assert.match(notes, /BRIDGE_E2E_TURN_1/);
assert.match(notes, /BRIDGE_E2E_TURN_2/);

const status = await taskService.status(opened.taskId);
const diff = await taskService.diff(opened.taskId, false);
clientPool.drop(opened.runtimeEndpoint);
store.close();

console.log(
  JSON.stringify(
    {
      status: "passed",
      taskId: opened.taskId,
      runtimeHostId: opened.runtimeHostId,
      runtimeEndpoint: opened.runtimeEndpoint,
      codexThreadId: opened.codexThreadId,
      firstTurnId: first.turnId,
      secondTurnId: second.turnId,
      fixtureRoot,
      statusSnapshot: status,
      diff,
    },
    null,
    2,
  ),
);

async function prepareFixture(): Promise<void> {
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.writeFile(notesPath, "Codex Bridge MCP real E2E fixture\n", "utf8");
  runGit(["init"]);
  runGit(["add", "notes.txt"]);
}

async function runTurn(
  instruction: string,
  taskId: string,
): Promise<{
  runtimeHostId: string;
  codexThreadId: string;
  turnId: string;
}> {
  const started = await taskService.sendTask({ taskId, instruction });
  const deadline = Date.now() + timeoutMs;
  let afterSeq = 0;
  const decidedApprovals = new Set<string>();

  while (Date.now() < deadline) {
    const status = await taskService.status(taskId, { includeApprovalPayload: true });
    const pendingApproval = status.pendingApproval as ApprovalRecord | null;
    if (pendingApproval && !decidedApprovals.has(pendingApproval.id)) {
      decidedApprovals.add(pendingApproval.id);
      const decision = isSafeFixtureApproval(pendingApproval) ? "approve" : "deny";
      await taskService.decideApproval({
        taskId,
        approvalId: pendingApproval.id,
        decision,
        reason:
          decision === "approve"
            ? "E2E harness approval for fixture-local safe action."
            : "E2E harness denied non-fixture or unsafe action.",
      });
      console.log(`${decision} approval ${pendingApproval.kind}: ${pendingApproval.command ?? ""}`);
    }

    const batch = await taskService.events({
      taskId,
      afterSeq,
      limit: 100,
      markDelivered: false,
      includePayload: true,
    });
    for (const event of batch.events) {
      afterSeq = Math.max(afterSeq, event.seq);
    }
    const completed = batch.events.find(
      (event) => event.eventType === "codex_turn_completed" && event.codexTurnId === started.turnId,
    );
    if (completed) {
      assertTurnSucceeded(completed);
      return started;
    }

    await delay(2_000);
  }

  throw new Error(`Timed out waiting for Codex turn to complete: ${started.turnId}`);
}

function isSafeFixtureApproval(approval: ApprovalRecord): boolean {
  if (approval.cwd && path.resolve(approval.cwd) !== fixtureRoot) {
    return false;
  }

  if (approval.kind === "item/fileChange/requestApproval") {
    const payload = approval.payload as { grantRoot?: string | null } | null;
    return !payload?.grantRoot || path.resolve(payload.grantRoot) === fixtureRoot;
  }

  if (approval.kind === "item/commandExecution/requestApproval") {
    const command = (approval.command ?? "").toLowerCase();
    if (!command) {
      return false;
    }
    const denied = [
      "curl",
      "invoke-webrequest",
      "wget",
      "npm install",
      "pnpm install",
      "yarn install",
      "remove-item",
      "del ",
      "erase ",
      "rmdir",
      "rm ",
      "git reset",
      "git clean",
      "git checkout",
      "git commit",
      "git push",
    ];
    return !denied.some((token) => command.includes(token));
  }

  return false;
}

function assertTurnSucceeded(event: EventRecord): void {
  const payload = event.payload as { params?: { turn?: { status?: string }; status?: string } } | null;
  const status = payload?.params?.turn?.status ?? payload?.params?.status;
  if (status && status !== "completed") {
    throw new Error(`Codex turn finished with non-completed status: ${status}`);
  }
}

function runGit(args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
}
