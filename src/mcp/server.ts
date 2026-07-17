import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeCoreServices } from "../core/bridgeCore.js";
import { registerTools } from "./tools.js";

export const bridgeInstructions = [
  "Codex Bridge MCP keeps a task orchestrator, such as Claude Code or Codex, connected to one long-lived Codex Runtime Host.",
  "On every task_open, pass orchestrator.kind plus the stable conversation/session identifier supplied by the orchestrator application. If the application exposes no identifier, generate one once for the conversation and keep reusing it; never use or generate a per-call MCP transport session id.",
  "One orchestrator identity binds permanently to one Bridge task and one Codex thread. Reopening with that identity continues its bound task even if the requested title changes, while that task remains the active project session.",
  "A different orchestrator identity cannot silently reuse a bound active task. Use mode=new only when intentionally opening independent work in the same project; use task_recover with the known bound taskId when restoring a session that is no longer the active project session.",
  "Clients that cannot supply a stable orchestrator identity must continue an existing task with mode=reuse plus expectedTaskId; if the taskId was lost, use task_list first.",
  "After opening a task, send ordinary follow-ups with task_send instead of reopening it.",
  "Use task_send for every follow-up instruction on the same taskId; it waits until Codex needs approval or reaches a terminal state.",
  "If an MCP call is cancelled or the client reconnects, use task_await with the last attention revision instead of polling task_status or task_events.",
  "Do not ask this bridge to use CLI resume commands.",
  "Approval requests must be handled by the task orchestrator through approval_decide.",
  "After completed attention, call task_diff before accepting the work.",
].join("\n");

/** Creates one protocol session backed by the shared, long-lived Bridge Core. */
export function createMcpServer(services: BridgeCoreServices): McpServer {
  const server = new McpServer(
    {
      name: "codex-bridge-mcp",
      version: "0.1.0",
    },
    {
      instructions: bridgeInstructions,
    },
  );
  registerTools(
    server,
    services.taskService,
    services.compactService,
    services.recoveryService,
  );
  return server;
}
