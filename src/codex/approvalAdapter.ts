import { createId, nowIso } from "../shared/id.js";
import type { ApprovalRecord } from "../storage/sqlite.js";
import type { CodexNotification, CodexServerRequest } from "./codexProtocol.js";
import { asRecord } from "./codexProtocol.js";

export interface ApprovalContext {
  taskId: string;
  runtimeHostId: string;
  codexThreadId: string;
  codexTurnId: string | null;
}

export function isApprovalRequest(notification: CodexNotification): boolean {
  const method = notification.method.toLowerCase();
  if (method.includes("decision") || method.includes("resolved")) {
    return false;
  }
  return (
    method.includes("approval") ||
    method.includes("permission/request") ||
    method.includes("permission_request") ||
    method.includes("request_permissions")
  );
}

export function isApprovalServerRequest(request: CodexServerRequest): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
  ].includes(request.method);
}

export function approvalFromNotification(
  notification: CodexNotification,
  context: ApprovalContext,
): ApprovalRecord {
  const params = asRecord(notification.params);
  const requestId =
    asString(params.requestId) ??
    asString(params.approvalId) ??
    asString(params.id) ??
    asString(asRecord(params.request)?.id) ??
    createId("codex_request");
  const command =
    asString(params.command) ??
    asString(asRecord(params.exec)?.command) ??
    asString(asRecord(params.toolCall)?.command) ??
    null;
  return {
    id: createId("approval"),
    taskId: context.taskId,
    runtimeHostId: context.runtimeHostId,
    codexThreadId: context.codexThreadId,
    codexTurnId: context.codexTurnId,
    codexRequestId: requestId,
    kind: notification.method,
    command,
    cwd: asString(params.cwd) ?? null,
    reason: asString(params.reason) ?? asString(params.message) ?? null,
    riskSummary: asString(params.riskSummary) ?? asString(params.risk) ?? null,
    decision: null,
    decidedBy: null,
    decisionReason: null,
    payload: params,
    createdAt: nowIso(),
    resolvedAt: null,
  };
}

export function approvalFromServerRequest(
  request: CodexServerRequest,
  context: ApprovalContext,
): ApprovalRecord {
  const params = asRecord(request.params);
  const requestId = request.id;
  const commandValue = params.command;
  const command = Array.isArray(commandValue)
    ? commandValue.map(String).join(" ")
    : asString(commandValue);
  return {
    id: createId("approval"),
    taskId: context.taskId,
    runtimeHostId: context.runtimeHostId,
    codexThreadId: context.codexThreadId,
    codexTurnId: context.codexTurnId ?? asString(params.turnId),
    codexRequestId: requestId,
    kind: request.method,
    command,
    cwd: asString(params.cwd) ?? null,
    reason: asString(params.reason) ?? asString(params.message) ?? null,
    riskSummary: asString(params.riskSummary) ?? asString(params.risk) ?? null,
    decision: null,
    decidedBy: null,
    decisionReason: null,
    payload: params,
    createdAt: nowIso(),
    resolvedAt: null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
