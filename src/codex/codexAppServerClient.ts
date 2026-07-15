import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config, type BridgeConfig } from "../config/config.js";
import { delay } from "../runtime/heartbeat.js";
import type {
  ApprovalServerResponse,
  CodexNotification,
  CodexServerRequest,
  JsonRpcId,
  JsonRpcIncoming,
  JsonRpcRequest,
} from "./codexProtocol.js";
import { asRecord, isFailure, isNotification, isServerRequest } from "./codexProtocol.js";
import type {
  InitializeParams,
  InitializeResponse,
} from "./generated/index.js";
import type {
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartParams,
  TurnStartResponse,
} from "./generated/v2/index.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingServerResolution {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CodexRequestMap {
  initialize: {
    params: InitializeParams;
    result: InitializeResponse;
  };
  "thread/start": {
    params: ThreadStartParams;
    result: ThreadStartResponse;
  };
  "thread/resume": {
    params: ThreadResumeParams;
    result: ThreadResumeResponse;
  };
  "thread/name/set": {
    params: ThreadSetNameParams;
    result: ThreadSetNameResponse;
  };
  "thread/compact/start": {
    params: ThreadCompactStartParams;
    result: ThreadCompactStartResponse;
  };
  "thread/read": {
    params: ThreadReadParams;
    result: ThreadReadResponse;
  };
  "turn/start": {
    params: TurnStartParams;
    result: TurnStartResponse;
  };
}

export interface TurnStartInput {
  threadId: string;
  text: string;
  cwd?: string;
}

export class CodexAppServerClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private initialized = false;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly pendingServerResolutions = new Map<string, PendingServerResolution>();
  private readonly loadedThreads = new Set<string>();
  private readonly loadingThreads = new Map<string, Promise<void>>();

  constructor(
    readonly endpoint: string,
    private readonly bridgeConfig: BridgeConfig = config,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectInternal(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.endpoint);
      const fail = (error: Error) => {
        socket.removeAllListeners();
        reject(error);
      };
      socket.once("open", () => {
        socket.removeListener("error", fail);
        this.socket = socket;
        this.bindSocket(socket);
        resolve();
      });
      socket.once("error", fail);
    });

    try {
      await this.initialize();
    } catch (error) {
      this.drop();
      throw error;
    }
  }

  async threadStart(input: { cwd: string; developerInstructions?: string }): Promise<string> {
    const params = {
      model: this.bridgeConfig.codexModel ?? undefined,
      serviceTier: this.bridgeConfig.codexServiceTier ?? undefined,
      cwd: input.cwd,
      runtimeWorkspaceRoots: [input.cwd],
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      config: buildCodexConfig(this.bridgeConfig),
      developerInstructions: input.developerInstructions,
    } satisfies ThreadStartParams;
    const result = await this.request("thread/start", params);
    const threadId = result.thread.id;
    if (!threadId) {
      throw new Error("Codex App Server did not return a thread id");
    }
    this.loadedThreads.add(threadId);
    return threadId;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    const params = { threadId, name } satisfies ThreadSetNameParams;
    await this.request("thread/name/set", params);
  }

  async ensureThreadReady(
    threadId: string,
    cwd?: string,
    developerInstructions?: string,
  ): Promise<void> {
    if (this.loadedThreads.has(threadId)) {
      return;
    }
    const existing = this.loadingThreads.get(threadId);
    if (existing) {
      return existing;
    }
    const loading = (async () => {
      const params = {
        threadId,
        model: this.bridgeConfig.codexModel ?? undefined,
        serviceTier: this.bridgeConfig.codexServiceTier ?? undefined,
        cwd,
        runtimeWorkspaceRoots: cwd ? [cwd] : undefined,
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        config: buildCodexConfig(this.bridgeConfig),
        developerInstructions,
        excludeTurns: true,
      } satisfies ThreadResumeParams;
      await this.request("thread/resume", params);
      this.loadedThreads.add(threadId);
    })().finally(() => {
      this.loadingThreads.delete(threadId);
    });
    this.loadingThreads.set(threadId, loading);
    return loading;
  }

  async turnStart(input: TurnStartInput): Promise<string> {
    const params = {
      threadId: input.threadId,
      cwd: input.cwd,
      runtimeWorkspaceRoots: input.cwd ? [input.cwd] : undefined,
      sandboxPolicy: input.cwd
        ? {
            type: "workspaceWrite",
            writableRoots: [input.cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
        : undefined,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      approvalsReviewer: "user",
      model: this.bridgeConfig.codexModel ?? undefined,
      serviceTier: this.bridgeConfig.codexServiceTier ?? undefined,
      effort: this.bridgeConfig.codexReasoningEffort ?? undefined,
      summary: this.bridgeConfig.codexReasoningSummary ?? undefined,
    } satisfies TurnStartParams;
    const result = await this.request("turn/start", params);
    const turnId = result.turn.id;
    if (!turnId) {
      throw new Error("Codex App Server did not return a turn id");
    }
    return turnId;
  }

  async compactThread(threadId: string, cwd?: string): Promise<void> {
    await this.ensureThreadReady(threadId, cwd);
    const params = { threadId } satisfies ThreadCompactStartParams;
    await this.request("thread/compact/start", params);
  }

  async readThread(threadId: string): Promise<ThreadReadResponse["thread"]> {
    const result = await this.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    return result.thread;
  }

  async decideApproval(input: {
    codexRequestId: string | number;
    approvalKind: string;
    decision: "approve" | "deny";
    reason: string;
    payload?: unknown;
  }): Promise<void> {
    const response = buildApprovalResponse(input.approvalKind, input.decision, input.payload);
    const resolved = this.waitForServerRequestResolution(input.codexRequestId);
    if (response) {
      this.respondToServerRequest(input.codexRequestId, response);
    } else {
      this.rejectServerRequest(input.codexRequestId, -32000, input.reason);
    }
    await resolved;
  }

  drop(): void {
    this.loadedThreads.clear();
    this.loadingThreads.clear();
    this.initialized = false;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  private async initialize(): Promise<void> {
    const params = {
      clientInfo: {
        name: this.bridgeConfig.appServerClientName,
        title: this.bridgeConfig.appServerClientTitle,
        version: this.bridgeConfig.appServerClientVersion,
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    } satisfies InitializeParams;
    await this.request("initialize", params);
    this.notify("initialized", {});
    this.initialized = true;
  }

  private async request<M extends keyof CodexRequestMap>(
    method: M,
    params: CodexRequestMap[M]["params"],
    attempt = 0,
  ): Promise<CodexRequestMap[M]["result"]> {
    await this.ensureOpen();
    const id = this.nextId++;
    const message: JsonRpcRequest = { id, method, params };
    const response = new Promise<CodexRequestMap[M]["result"]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as CodexRequestMap[M]["result"]),
        reject,
      });
    });
    this.socket?.send(JSON.stringify(message));
    try {
      return await response;
    } catch (error) {
      const rpcError = error as Error & { code?: number };
      if (rpcError.code === -32001 && attempt < 5) {
        await delay(250 * 2 ** attempt + Math.floor(Math.random() * 100));
        return this.request(method, params, attempt + 1);
      }
      throw error;
    }
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const message = { method, params };
    this.socket?.send(JSON.stringify(message));
  }

  private respondToServerRequest(id: JsonRpcId, result: ApprovalServerResponse): void {
    this.socket?.send(JSON.stringify({ id, result }));
  }

  private rejectServerRequest(id: JsonRpcId, code: number, message: string): void {
    this.socket?.send(JSON.stringify({ id, error: { code, message } }));
  }

  private async ensureOpen(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error(`Codex App Server WebSocket is not open: ${this.endpoint}`);
    }
  }

  private bindSocket(socket: WebSocket): void {
    socket.on("message", (raw) => {
      const text = raw.toString("utf8");
      const message = JSON.parse(text) as JsonRpcIncoming;
      if (isNotification(message)) {
        if (message.method === "serverRequest/resolved") {
          const requestId = asRecord(message.params).requestId;
          if (typeof requestId === "string" || typeof requestId === "number") {
            const key = JSON.stringify(requestId);
            const pendingResolution = this.pendingServerResolutions.get(key);
            if (pendingResolution) {
              clearTimeout(pendingResolution.timeout);
              this.pendingServerResolutions.delete(key);
              pendingResolution.resolve();
            }
          }
        }
        this.emit("notification", {
          method: message.method,
          params: asRecord(message.params),
        } satisfies CodexNotification);
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending && isServerRequest(message)) {
        this.emit("serverRequest", {
          id: message.id,
          method: message.method,
          params: asRecord(message.params),
        } satisfies CodexServerRequest);
        return;
      }
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (isFailure(message)) {
        const error = new Error(message.error.message) as Error & { code?: number; data?: unknown };
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    });

    socket.on("close", () => {
      this.initialized = false;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`Codex App Server WebSocket closed: ${this.endpoint}`));
      }
      this.pending.clear();
      for (const pendingResolution of this.pendingServerResolutions.values()) {
        clearTimeout(pendingResolution.timeout);
        pendingResolution.reject(
          new Error(`Codex App Server WebSocket closed before approval was resolved: ${this.endpoint}`),
        );
      }
      this.pendingServerResolutions.clear();
      this.emit("disconnected", { endpoint: this.endpoint });
    });

    socket.on("error", (error) => {
      this.emit("error", error);
    });
  }

  private waitForServerRequestResolution(id: JsonRpcId): Promise<void> {
    const key = JSON.stringify(id);
    const existing = this.pendingServerResolutions.get(key);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.reject(new Error(`Duplicate pending approval response: ${key}`));
      this.pendingServerResolutions.delete(key);
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingServerResolutions.delete(key);
        reject(new Error(`Codex App Server did not confirm approval resolution: ${key}`));
      }, 10_000);
      timeout.unref();
      this.pendingServerResolutions.set(key, { resolve, reject, timeout });
    });
  }
}

function buildApprovalResponse(
  approvalKind: string,
  decision: "approve" | "deny",
  payload: unknown,
): ApprovalServerResponse | null {
  const accepted = decision === "approve";
  switch (approvalKind) {
    case "item/commandExecution/requestApproval":
      return { decision: accepted ? "accept" : "decline" };
    case "item/fileChange/requestApproval":
      return { decision: accepted ? "accept" : "decline" };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: accepted ? "approved" : "denied" };
    case "item/permissions/requestApproval": {
      if (!accepted) {
        return null;
      }
      const params = asRecord(payload);
      const permissions = asRecord(params.permissions);
      return {
        permissions: {
          network: permissions.network,
          fileSystem: permissions.fileSystem,
        },
        scope: "turn",
      };
    }
    default:
      return accepted ? { decision: "accept" } : { decision: "decline" };
  }
}

function buildCodexConfig(bridgeConfig: BridgeConfig): Record<string, string> {
  const codexConfig: Record<string, string> = {};
  if (bridgeConfig.codexReasoningEffort) {
    codexConfig.model_reasoning_effort = bridgeConfig.codexReasoningEffort;
  }
  if (bridgeConfig.codexReasoningSummary) {
    codexConfig.model_reasoning_summary = bridgeConfig.codexReasoningSummary;
  }
  if (bridgeConfig.codexVerbosity) {
    codexConfig.model_verbosity = bridgeConfig.codexVerbosity;
  }
  return codexConfig;
}

export class CodexClientPool {
  private readonly clients = new Map<string, CodexAppServerClient>();

  constructor(private readonly bridgeConfig: BridgeConfig = config) {}

  async getOrConnect(endpoint: string): Promise<CodexAppServerClient> {
    let client = this.clients.get(endpoint);
    if (!client) {
      client = new CodexAppServerClient(endpoint, this.bridgeConfig);
      this.clients.set(endpoint, client);
    }
    await client.connect();
    return client;
  }

  drop(endpoint: string): void {
    const client = this.clients.get(endpoint);
    client?.drop();
    this.clients.delete(endpoint);
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      client.drop();
    }
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }
}
