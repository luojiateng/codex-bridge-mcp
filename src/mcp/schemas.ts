import { z } from "zod";

export const TaskOpenSchema = z.object({
  projectRoot: z.string().min(1),
  title: z.string().min(1),
  requirements: z.any(),
  acceptanceCriteria: z.array(z.string()).default([]),
  tokenBudget: z.number().int().positive().optional(),
});

export const TaskSendSchema = z.object({
  taskId: z.string().min(1),
  instruction: z.string().min(1),
  runChecks: z.boolean().default(false),
});

export const TaskStatusSchema = z.object({
  taskId: z.string().min(1),
});

export const TaskEventsSchema = z.object({
  taskId: z.string().min(1),
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(200).default(50),
  markDelivered: z.boolean().default(true),
  includePayload: z.boolean().default(false),
});

export const TaskDiffSchema = z.object({
  taskId: z.string().min(1),
  includePatch: z.boolean().default(false),
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
