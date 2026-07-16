import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CompactService } from "../task/compactService.js";
import { RecoveryService } from "../task/recoveryService.js";
import {
  TaskService,
  type TaskAwaitInput,
  type TurnAttentionResponse,
} from "../task/taskService.js";
import { prettyJson } from "../shared/json.js";
import {
  ApprovalDecideSchema,
  TaskAwaitSchema,
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

type ToolRequestExtra = {
  signal: AbortSignal;
  requestId: string | number;
  sessionId?: string;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      message?: string;
    };
  }) => Promise<void>;
};

const configuredHeartbeatMs = Number(
  process.env.CODEX_BRIDGE_ATTENTION_HEARTBEAT_MS ?? 15_000,
);
const ATTENTION_HEARTBEAT_MS = Number.isFinite(configuredHeartbeatMs)
  ? Math.max(configuredHeartbeatMs, 1_000)
  : 15_000;

export function registerTools(
  server: McpServer,
  taskService: TaskService,
  compactService: CompactService,
  recoveryService: RecoveryService,
): void {
  server.tool("task_open", "Attach to the project's durable active Codex task/thread, or explicitly open a new isolated session with mode=new.", TaskOpenSchema.shape, async (input) =>
    jsonResult(await taskService.openTask(TaskOpenSchema.parse(input))),
  );

  server.tool(
    "task_send",
    "Send a follow-up through turn/start, then wait for approval, completion, failure, or interruption.",
    TaskSendSchema.shape,
    async (input, extra) => {
      const parsed = TaskSendSchema.parse(input);
      if (parsed.ackRevision !== undefined) {
        taskService.acknowledgeAttention(parsed.taskId, parsed.ackRevision);
      }
      const pending = taskService.getPendingAttention(parsed.taskId);
      if (pending) {
        const nextAction = pendingNextAction(pending);
        return jsonResult({
          ...pending,
          replayed: true,
          replayReason:
            "No new turn was started because this persisted attention has not been acknowledged; follow nextAction before calling task_send again.",
          nextAction,
          requiredAckRevision: nextAction === "task_send" ? pending.attention.revision : undefined,
        });
      }
      const started = await taskService.sendTask(parsed);
      return jsonResult(
        await waitForAttentionWithProgress(
          taskService,
          { taskId: started.taskId, turnId: started.turnId, afterRevision: 0 },
          extra,
        ),
      );
    },
  );

  server.tool(
    "task_await",
    "Resume waiting for a persisted turn attention revision after client cancellation or reconnect.",
    TaskAwaitSchema.shape,
    async (input, extra) =>
      jsonResult(
        await waitForAttentionWithProgress(taskService, TaskAwaitSchema.parse(input), extra),
      ),
  );

  server.tool("task_status", "Return a compact task/runtime/turn snapshot; request approval payload only when it is needed.", TaskStatusSchema.shape, async (input) => {
    const parsed = TaskStatusSchema.parse(input);
    return jsonResult(
      await taskService.status(parsed.taskId, {
        includeApprovalPayload: parsed.includeApprovalPayload,
      }),
    );
  });

  server.tool("task_events", "Return compact event pages; request raw payloads only for an event that needs diagnosis.", TaskEventsSchema.shape, async (input) =>
    jsonResult(await taskService.events(TaskEventsSchema.parse(input))),
  );

  server.tool("task_diff", "Return a short diff summary and paged file list; request a full patch only for line-level review.", TaskDiffSchema.shape, async (input) => {
    const parsed = TaskDiffSchema.parse(input);
    return jsonResult(await taskService.diff(parsed));
  });

  server.tool(
    "approval_decide",
    "Forward the task orchestrator's approval decision, then wait for the next attention event.",
    ApprovalDecideSchema.shape,
    async (input, extra) => {
      const resolved = await taskService.decideApproval(ApprovalDecideSchema.parse(input));
      if (!resolved.turnId) {
        return jsonResult(resolved);
      }
      const next = await waitForAttentionWithProgress(
        taskService,
        {
          taskId: resolved.taskId,
          turnId: resolved.turnId,
          afterRevision: resolved.attentionRevision,
        },
        extra,
      );
      return jsonResult({ approval: resolved, ...next });
    },
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

function pendingNextAction(attention: TurnAttentionResponse): string {
  switch (attention.attention.kind) {
    case "approval":
      return "approval_decide";
    case "completed":
      return "task_diff";
    case "failed":
    case "interrupted":
      return "task_send";
    default:
      return "task_await";
  }
}

async function waitForAttentionWithProgress(
  taskService: TaskService,
  input: TaskAwaitInput,
  extra: ToolRequestExtra,
): Promise<TurnAttentionResponse> {
  const startedAt = Date.now();
  const progressToken = extra._meta?.progressToken;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (progressToken !== undefined) {
    const sendHeartbeat = () => {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: elapsedSeconds,
            message: `Codex is still running (task=${input.taskId}, turn=${input.turnId ?? "latest"}, elapsed=${elapsedSeconds}s)`,
          },
        })
        .catch(() => undefined);
    };
    sendHeartbeat();
    heartbeat = setInterval(sendHeartbeat, ATTENTION_HEARTBEAT_MS);
    heartbeat.unref();
  }
  try {
    return await taskService.waitForAttention(input, extra.signal, {
      requestId: extra.requestId,
      sessionId: extra.sessionId,
    });
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}
