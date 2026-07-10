import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CompactService } from "../task/compactService.js";
import { RecoveryService } from "../task/recoveryService.js";
import { TaskService } from "../task/taskService.js";
import { prettyJson } from "../shared/json.js";
import {
  ApprovalDecideSchema,
  TaskCompactSchema,
  TaskDiffSchema,
  TaskEventsSchema,
  TaskListSchema,
  TaskOpenSchema,
  TaskRecoverSchema,
  TaskSendSchema,
  TaskStatusSchema,
} from "./schemas.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

export function registerTools(
  server: McpServer,
  taskService: TaskService,
  compactService: CompactService,
  recoveryService: RecoveryService,
): void {
  server.tool("task_open", "Open one Codex task and bind it to one Codex thread.", TaskOpenSchema.shape, async (input) =>
    jsonResult(await taskService.openTask(TaskOpenSchema.parse(input))),
  );

  server.tool("task_send", "Send a follow-up instruction through turn/start on the existing thread.", TaskSendSchema.shape, async (input) =>
    jsonResult(await taskService.sendTask(TaskSendSchema.parse(input))),
  );

  server.tool("task_status", "Return a short task/runtime/turn status snapshot.", TaskStatusSchema.shape, async (input) => {
    const parsed = TaskStatusSchema.parse(input);
    return jsonResult(await taskService.status(parsed.taskId));
  });

  server.tool("task_events", "Return undelivered or after-sequence events without full logs.", TaskEventsSchema.shape, async (input) =>
    jsonResult(await taskService.events(TaskEventsSchema.parse(input))),
  );

  server.tool("task_diff", "Return summarized working-tree diff for Claude review.", TaskDiffSchema.shape, async (input) => {
    const parsed = TaskDiffSchema.parse(input);
    return jsonResult(await taskService.diff(parsed.taskId, parsed.includePatch));
  });

  server.tool("approval_decide", "Forward Claude's approval decision to Codex.", ApprovalDecideSchema.shape, async (input) =>
    jsonResult(await taskService.decideApproval(ApprovalDecideSchema.parse(input))),
  );

  server.tool("task_compact", "Start Codex thread compaction for a task.", TaskCompactSchema.shape, async (input) => {
    const parsed = TaskCompactSchema.parse(input);
    return jsonResult(await compactService.compactTask(parsed.taskId));
  });

  server.tool("task_recover", "Recover a task by reconnecting runtime and resuming the known thread.", TaskRecoverSchema.shape, async (input) => {
    const parsed = TaskRecoverSchema.parse(input);
    return jsonResult(await recoveryService.recoverTask(parsed.taskId));
  });

  server.tool("task_list", "List known tasks, optionally filtered by projectRoot or status.", TaskListSchema.shape, async (input) =>
    jsonResult(await taskService.listTasks(TaskListSchema.parse(input))),
  );
}

function jsonResult(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: prettyJson(value),
      },
    ],
  };
}
