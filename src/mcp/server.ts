import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeCoreServices } from "../core/bridgeCore.js";
import { registerTools } from "./tools.js";

export const bridgeInstructions = [
  "Codex Bridge MCP keeps a task orchestrator, such as Claude Code or Codex, connected to one long-lived Codex Runtime Host.",
  "Use task_open to attach to the project's durable active session; it reuses the existing task/thread by default even after reconnects or context loss.",
  "Set task_open mode=new only when the user explicitly wants an isolated Codex thread; ordinary follow-ups must keep mode=reuse and use the returned taskId.",
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
