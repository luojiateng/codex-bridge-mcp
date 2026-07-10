import type { CodexNotification } from "./codexProtocol.js";

export interface NormalizedCodexEvent {
  eventType: string;
  codexThreadId: string | null;
  codexTurnId: string | null;
  payload: Record<string, unknown>;
}

export interface TokenUsageSnapshot {
  totalTokens: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  lastTotalTokens: number | null;
  modelContextWindow: number | null;
}

export function normalizeCodexEvent(notification: CodexNotification): NormalizedCodexEvent {
  const method = notification.method;
  const params = notification.params;
  const codexTurnId = extractTurnId(params);
  const codexThreadId = extractThreadId(params);
  if (method === "thread/tokenUsage/updated") {
    const tokenUsage = extractTokenUsageSnapshot(params);
    return {
      eventType: "codex_thread_token_usage_updated",
      codexThreadId,
      codexTurnId,
      payload: {
        method,
        type: "token_usage_updated",
        threadId: codexThreadId,
        turnId: codexTurnId,
        tokenUsage,
        nextAction: "task_status",
      },
    };
  }

  return {
    eventType: toEventType(method),
    codexThreadId,
    codexTurnId,
    payload: {
      method,
      params,
      nextAction: method === "turn/completed" ? "task_diff" : undefined,
    },
  };
}

export function extractThreadId(params: Record<string, unknown> | undefined): string | null {
  if (!params) {
    return null;
  }
  const direct = asString(params.threadId);
  if (direct) {
    return direct;
  }
  const conversationId = asString(params.conversationId);
  if (conversationId) {
    return conversationId;
  }
  const thread = asRecord(params.thread);
  return asString(thread?.id) ?? null;
}

export function extractTurnId(params: Record<string, unknown> | undefined): string | null {
  if (!params) {
    return null;
  }
  const direct = asString(params.turnId);
  if (direct) {
    return direct;
  }
  const turn = asRecord(params.turn);
  if (turn) {
    return asString(turn.id);
  }
  const item = asRecord(params.item);
  return asString(item?.turnId) ?? null;
}

export function extractTokenUsageSnapshot(
  params: Record<string, unknown> | undefined,
): TokenUsageSnapshot | null {
  const tokenUsage = asRecord(params?.tokenUsage);
  const total = asRecord(tokenUsage?.total);
  const last = asRecord(tokenUsage?.last);
  const totalTokens = asNumber(total?.totalTokens);
  if (totalTokens === null) {
    return null;
  }
  return {
    totalTokens,
    inputTokens: asNumber(total?.inputTokens),
    cachedInputTokens: asNumber(total?.cachedInputTokens),
    outputTokens: asNumber(total?.outputTokens),
    reasoningOutputTokens: asNumber(total?.reasoningOutputTokens),
    lastTotalTokens: asNumber(last?.totalTokens),
    modelContextWindow: asNumber(tokenUsage?.modelContextWindow),
  };
}

function toEventType(method: string): string {
  if (method === "turn/completed") {
    return "codex_turn_completed";
  }
  return `codex_${method.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
