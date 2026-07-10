import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type JsonObject = Record<string, unknown>;

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const entrypoint = path.join(projectRoot, "dist", "index.js");
const defaultFixtureBase = process.platform === "win32" ? "E:\\tmp" : os.tmpdir();
const fixtureRoot = path.resolve(
  process.env.CODEX_BRIDGE_CLAUDE_DEMO_PROJECT_ROOT ??
    path.join(defaultFixtureBase, "codex-bridge-mcp-claude-demo"),
);
const demoFile = path.join(fixtureRoot, "claude-demo.txt");
const dataDir = path.join(fixtureRoot, ".codex-bridge-data");
let eventCursor = 0;

await prepareFixture();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint],
  cwd: projectRoot,
  env: {
    ...stringEnv(),
    CODEX_BRIDGE_DATA_DIR: dataDir,
  },
  stderr: "pipe",
});

const client = new Client(
  {
    name: "claude-code-simulator",
    version: "0.1.0",
  },
  {
    capabilities: {},
  },
);

try {
  await client.connect(transport);

  const tools = await client.listTools();
  logStep("Claude checks MCP tool surface", {
    tools: tools.tools.map((tool) => tool.name),
  });

  const opened = await callToolJson("task_open", {
    projectRoot: fixtureRoot,
    title: `Claude MCP Demo ${new Date().toISOString()}`,
    requirements:
      "Use Codex through Codex Bridge MCP. Append two exact lines to claude-demo.txt.",
    acceptanceCriteria: [
      "The same task uses one Codex thread.",
      "Both task_send turns use the same Runtime Host.",
      "claude-demo.txt contains CLAUDE_MCP_DEMO_TURN_1 and CLAUDE_MCP_DEMO_TURN_2.",
      "Claude reviews task_diff after Codex completes.",
    ],
  });
  logStep("Claude -> task_open", summarize(opened));

  const first = await runClaudeTurn(
    String(opened.taskId),
    "Append this exact line to claude-demo.txt and do not change anything else: CLAUDE_MCP_DEMO_TURN_1",
  );
  logStep("Claude observed first turn completion", summarize(first));

  const second = await runClaudeTurn(
    String(opened.taskId),
    "Append this exact line to claude-demo.txt and do not change anything else: CLAUDE_MCP_DEMO_TURN_2",
  );
  logStep("Claude observed second turn completion", summarize(second));

  assert.equal(first.runtimeHostId, opened.runtimeHostId);
  assert.equal(second.runtimeHostId, opened.runtimeHostId);
  assert.equal(first.codexThreadId, opened.codexThreadId);
  assert.equal(second.codexThreadId, opened.codexThreadId);

  const diff = await callToolJson("task_diff", {
    taskId: opened.taskId,
    includePatch: false,
  });
  logStep("Claude -> task_diff review", diff);

  const status = await callToolJson("task_status", {
    taskId: opened.taskId,
  });
  logStep("Claude -> task_status final snapshot", summarize(status));

  const content = await fs.readFile(demoFile, "utf8");
  assert.match(content, /CLAUDE_MCP_DEMO_TURN_1/);
  assert.match(content, /CLAUDE_MCP_DEMO_TURN_2/);

  logStep("Local acceptance evidence", {
    fixtureRoot,
    demoFile,
    containsTurn1: content.includes("CLAUDE_MCP_DEMO_TURN_1"),
    containsTurn2: content.includes("CLAUDE_MCP_DEMO_TURN_2"),
    sameRuntimeHost: first.runtimeHostId === second.runtimeHostId,
    sameCodexThread: first.codexThreadId === second.codexThreadId,
  });
} finally {
  await client.close();
}

async function runClaudeTurn(taskId: string, instruction: string): Promise<JsonObject> {
  const started = await callToolJson("task_send", { taskId, instruction });
  logStep("Claude -> task_send", summarize(started));
  const deadline = Date.now() + Number(process.env.CODEX_BRIDGE_CLAUDE_DEMO_TIMEOUT_MS ?? 240_000);
  const decidedApprovals = new Set<string>();

  while (Date.now() < deadline) {
    const status = await callToolJson("task_status", { taskId });
    const pendingApproval = toRecord(status.pendingApproval);
    if (pendingApproval && !decidedApprovals.has(String(pendingApproval.id))) {
      decidedApprovals.add(String(pendingApproval.id));
      const safe = isFixtureApproval(pendingApproval);
      const decision = safe ? "approve" : "deny";
      const approvalResult = await callToolJson("approval_decide", {
        taskId,
        approvalId: pendingApproval.id,
        decision,
        reason: safe
          ? "Claude simulator approved fixture-local action requested by the current task."
          : "Claude simulator denied action outside the fixture or outside the stated task.",
      });
      logStep("Claude -> approval_decide", summarize(approvalResult));
    }

    const events = await callToolJson("task_events", {
      taskId,
      afterSeq: eventCursor,
      limit: 50,
      markDelivered: false,
    });
    const batch = Array.isArray(events.events) ? (events.events as JsonObject[]) : [];
    for (const event of batch) {
      eventCursor = Math.max(eventCursor, Number(event.seq ?? 0));
    }
    const interesting = batch.filter((event) =>
      ["approval_requested", "codex_turn_completed", "context_near_limit"].includes(
        String(event.eventType),
      ),
    );
    if (interesting.length > 0) {
      logStep("Claude <- task_events summaries", interesting.map(summarize));
    }
    if (
      batch.some(
        (event) =>
          event.eventType === "codex_turn_completed" && event.codexTurnId === started.turnId,
      )
    ) {
      return started;
    }

    await delay(2_000);
  }

  throw new Error(`Timed out waiting for Codex turn to complete: ${String(started.turnId)}`);
}

async function callToolJson(name: string, args: JsonObject): Promise<JsonObject> {
  const result = await client.callTool({ name, arguments: args });
  const content = "content" in result && Array.isArray(result.content) ? result.content : [];
  const text = content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error(`Tool ${name} returned no text content`);
  }
  return JSON.parse(text) as JsonObject;
}

async function prepareFixture(): Promise<void> {
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.writeFile(demoFile, "Codex Bridge MCP Claude simulator fixture\n", "utf8");
  runGit(["init"]);
  runGit(["add", "claude-demo.txt"]);
}

function isFixtureApproval(approval: JsonObject): boolean {
  const cwd = typeof approval.cwd === "string" ? path.resolve(approval.cwd) : null;
  if (cwd && cwd !== fixtureRoot) {
    return false;
  }
  const kind = String(approval.kind ?? "");
  if (kind === "item/fileChange/requestApproval") {
    return true;
  }
  if (kind === "item/commandExecution/requestApproval") {
    const command = String(approval.command ?? "").toLowerCase();
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
    return command.length > 0 && !denied.some((token) => command.includes(token));
  }
  return false;
}

function summarize(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as JsonObject;
  return {
    taskId: record.taskId,
    runtimeHostId: record.runtimeHostId ?? toRecord(record.runtime)?.runtimeHostId,
    runtimeEndpoint: record.runtimeEndpoint ?? toRecord(record.runtime)?.endpoint,
    codexThreadId: record.codexThreadId ?? toRecord(record.codex)?.threadId,
    turnId: record.turnId ?? toRecord(record.codex)?.turnId,
    status: record.status,
    eventType: record.eventType,
    summary: record.summary,
    nextAction: record.nextAction,
    queue: record.queue,
    context: record.context,
    diffSummary: record.summary ? undefined : record.diffSummary,
  };
}

function toRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function logStep(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
