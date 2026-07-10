import type { RequestId, ServerNotification, ServerRequest } from "./generated/index.js";
import type {
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalResponse,
  PermissionsRequestApprovalResponse,
} from "./generated/v2/index.js";

export type JsonRpcId = RequestId;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcFailure {
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export type JsonRpcIncoming<T = unknown> =
  | JsonRpcSuccess<T>
  | JsonRpcFailure
  | JsonRpcNotification
  | JsonRpcServerRequest;

export type CodexNotification = ServerNotification | {
  method: string;
  params: Record<string, unknown>;
};

export type CodexServerRequest = ServerRequest | JsonRpcServerRequest;

export type ApprovalServerResponse =
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse
  | { decision: "approved" | "denied" | "abort" }
  | { decision: string }
  | Record<string, unknown>;

export function isNotification(message: JsonRpcIncoming): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isServerRequest(message: JsonRpcIncoming): message is JsonRpcServerRequest {
  return "method" in message && "id" in message;
}

export function isFailure(message: JsonRpcIncoming): message is JsonRpcFailure {
  return "error" in message;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
