import { z } from "zod";

export const OrchestratorIdentitySchema = z.object({
  kind: z
    .enum(["claude", "codex", "cursor", "other"])
    .describe("The task-orchestrator application that owns this conversation."),
  sessionId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .describe(
      "Stable application-level conversation identifier. Reuse it for every task_open in this conversation; never use a per-call MCP transport session id.",
    ),
}).describe("Stable task-orchestrator conversation identity for one-to-one Codex binding.");

export const TaskOpenSchema = z.object({
  projectRoot: z.string().min(1),
  title: z.string().min(1),
  requirements: z.any(),
  acceptanceCriteria: z.array(z.string()).default([]),
  tokenBudget: z.number().int().positive().optional(),
  mode: z.enum(["reuse", "new"]).default("reuse"),
  expectedTaskId: z.string().min(1).optional(),
  orchestrator: OrchestratorIdentitySchema.optional(),
});

export const TaskSendSchema = z.object({
  taskId: z.string().min(1),
  instruction: z.string().min(1),
  runChecks: z.boolean().default(false),
  ackRevision: z.number().int().nonnegative().optional(),
});

export const TaskAwaitSchema = z.object({
  taskId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  afterRevision: z.number().int().nonnegative().default(0),
  ackRevision: z.number().int().nonnegative().optional(),
});

export const TaskStatusSchema = z.object({
  taskId: z.string().min(1),
  includeApprovalPayload: z.boolean().default(false),
});

export const TaskEventsSchema = z.object({
  taskId: z.string().min(1),
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(200).default(20),
  markDelivered: z.boolean().default(true),
  includePayload: z.boolean().default(false),
});

export const TaskDiffSchema = z.object({
  taskId: z.string().min(1),
  includePatch: z.boolean().default(false),
  fileOffset: z.number().int().nonnegative().default(0),
  fileLimit: z.number().int().positive().max(200).default(50),
  includeAllFiles: z.boolean().default(false),
});

export const ApprovalDecideSchema = z.object({
  taskId: z.string().min(1),
  approvalId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
  reason: z.string().min(1),
});

export const TaskCompactSchema = z.object({
  taskId: z.string().min(1),
});

export const TaskRecoverSchema = z.object({
  taskId: z.string().min(1),
});

export const TaskListSchema = z.object({
  projectRoot: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(20),
});
