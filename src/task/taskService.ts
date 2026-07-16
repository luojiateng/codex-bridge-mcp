import fs from "node:fs/promises";
import path from "node:path";
import type { CodexNotification } from "../codex/codexProtocol.js";
import type { CodexServerRequest } from "../codex/codexProtocol.js";
import { CodexClientPool, type CodexAppServerClient } from "../codex/codexAppServerClient.js";
import {
  approvalFromNotification,
  approvalFromServerRequest,
  isApprovalRequest,
  isApprovalServerRequest,
} from "../codex/approvalAdapter.js";
import {
  extractThreadId,
  extractTokenUsageSnapshot,
  extractTurnId,
  normalizeCodexEvent,
} from "../codex/eventNormalizer.js";
import { config, type BridgeConfig } from "../config/config.js";
import { isHttpReady } from "../runtime/heartbeat.js";
import { RuntimeHostManager } from "../runtime/runtimeHostManager.js";
import {
  type CodexTuiWindowResult,
  TuiWindowManager,
} from "../runtime/tuiWindowManager.js";
import { DiffService } from "../review/diffService.js";
import { createId, createTaskId, nowIso } from "../shared/id.js";
import { canonicalizeProjectRoot } from "../shared/projectRoot.js";
import { JsonlLogger } from "../storage/jsonlLogger.js";
import {
  type ApprovalRecord,
  type EventRecord,
  type ProjectSessionRecord,
  type RuntimeHostRecord,
  type TaskRecord,
  type TurnRecord,
  SqliteStore,
} from "../storage/sqlite.js";
import {
  buildCodexDeveloperInstructions,
  buildCodexInstruction,
} from "./codexInstruction.js";
import { TaskQueue } from "./taskQueue.js";
import {
  ProjectSessionCoordinator,
  type ProjectSessionAcquisition,
} from "./projectSessionCoordinator.js";

export interface TaskOpenInput {
  projectRoot: string;
  title: string;
  requirements?: unknown;
  acceptanceCriteria: unknown[];
  tokenBudget?: number;
  mode?: "reuse" | "new";
}

export interface TaskSendInput {
  taskId: string;
  instruction: string;
  runChecks?: boolean;
  ackRevision?: number;
}

export interface TaskOpenResult {
  taskId: string;
  runtimeHostId: string;
  runtimeEndpoint: string;
  codexThreadId: string;
  projectSessionId: string;
  sessionGeneration: number;
  codexTui: {
    launched: boolean;
    mode: "off" | "remote" | "resume";
    pid: number | null;
    reason?: string;
  };
  status: "opened" | "reused";
  nextAction: "task_send" | "task_await" | "task_diff" | "approval_decide";
  requiredAckRevision?: number;
  pendingAttention?: TurnAttentionResponse;
}

export interface TaskAwaitInput {
  taskId: string;
  turnId?: string;
  afterRevision?: number;
  ackRevision?: number;
}

export interface TurnAttentionResponse {
  taskId: string;
  runtimeHostId: string;
  codexThreadId: string;
  turnId: string;
  status: string;
  attention: {
    revision: number;
    kind: string;
    payload: unknown;
    result: unknown;
    updatedAt: string;
  };
}

export interface AttentionWaitContext {
  requestId?: string | number;
  sessionId?: string;
}

export interface TaskEventsInput {
  taskId: string;
  afterSeq?: number;
  limit?: number;
  markDelivered?: boolean;
  includePayload?: boolean;
}

export interface TaskStatusOptions {
  includeApprovalPayload?: boolean;
}

export interface TaskDiffInput {
  taskId: string;
  includePatch?: boolean;
  fileOffset?: number;
  fileLimit?: number;
  includeAllFiles?: boolean;
}

export interface TaskListInput {
  projectRoot?: string;
  status?: string;
  limit: number;
}

export interface ApprovalDecisionInput {
  taskId: string;
  approvalId: string;
  decision: "approve" | "deny";
  reason: string;
}

interface TaskContext {
  taskId: string;
  runtimeHostId: string;
  codexThreadId: string;
}

interface EventSummary {
  seq: number;
  codexTurnId: string | null;
  eventType: string;
  summary: string;
  nextAction?: unknown;
  details?: Record<string, unknown>;
  createdAt: string;
}

interface ApprovalSummary {
  id: string;
  codexTurnId: string | null;
  kind: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  riskSummary: string | null;
  createdAt: string;
}

const CONTEXT_STATUS_WARNING_PERCENT = 70;
const CONTEXT_NEAR_LIMIT_PERCENT = 85;
const CONTEXT_BASELINE_TOKENS = 12_000;

export class TaskService {
  private readonly queue = new TaskQueue();
  private readonly attachedClients = new WeakSet<CodexAppServerClient>();
  private readonly threadContexts = new Map<string, TaskContext>();
  private readonly turnContexts = new Map<string, TaskContext>();
  private readonly attentionWaiters = new Map<string, Set<() => void>>();
  private startupRecovery: Promise<void> | null = null;

  constructor(
    private readonly store: SqliteStore,
    private readonly runtimeHostManager: RuntimeHostManager,
    private readonly clientPool: CodexClientPool,
    private readonly logger: JsonlLogger,
    private readonly diffService: DiffService,
    private readonly bridgeConfig: BridgeConfig = config,
    private readonly projectSessions: ProjectSessionCoordinator = new ProjectSessionCoordinator(store),
    private readonly tuiWindowManager: TuiWindowManager = new TuiWindowManager(store, bridgeConfig),
  ) {}

  start(): Promise<void> {
    if (this.startupRecovery) {
      return this.startupRecovery;
    }
    this.startupRecovery = this.recoverInterruptedQueue().catch(async (error: unknown) => {
      await this.logger
        .append("runtime", "startup", {
          type: "runtime_dependent_recovery_failed",
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      throw error;
    });
    return this.startupRecovery;
  }

  stop(): void {
    for (const waiters of this.attentionWaiters.values()) {
      for (const waiter of waiters) {
        waiter();
      }
    }
    this.attentionWaiters.clear();
    this.threadContexts.clear();
    this.turnContexts.clear();
    this.tuiWindowManager.stop();
  }

  waitForStartupRecovery(): Promise<void> {
    return this.start();
  }

  bindTaskRuntimeEvents(
    task: TaskRecord,
    runtime: RuntimeHostRecord,
    client: CodexAppServerClient,
  ): void {
    this.attachRuntimeEvents(runtime, client);
    this.registerTaskContext(task);
  }

  async openTask(input: TaskOpenInput): Promise<TaskOpenResult> {
    const acquisition = await this.projectSessions.acquire(input.projectRoot, input.mode ?? "reuse");
    if (acquisition.outcome === "reuse") {
      return this.reuseProjectSession(acquisition);
    }

    try {
      const runtime = await this.runtimeHostManager.ensureRuntimeHost(
        acquisition.canonical.projectRoot,
      );
      const client = await this.clientPool.getOrConnect(runtime.endpoint);
      this.attachRuntimeEvents(runtime, client);
      const threadId = await client.threadStart({
        cwd: acquisition.canonical.projectRoot,
        developerInstructions: buildCodexDeveloperInstructions(),
      });
      await client.setThreadName(threadId, input.title).catch(async (error: unknown) => {
        await this.logger.append("runtime", runtime.id, {
          type: "thread_name_set_failed",
          runtimeId: runtime.id,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      const now = nowIso();
      const task: TaskRecord = {
        id: createTaskId(acquisition.canonical.projectRoot, input.title),
        title: input.title,
        projectRoot: acquisition.canonical.projectRoot,
        runtimeHostId: runtime.id,
        codexThreadId: threadId,
        codexThreadName: input.title,
        status: "opened",
        requirements: input.requirements,
        acceptanceCriteria: input.acceptanceCriteria,
        tokenBudget: input.tokenBudget ?? null,
        createdAt: now,
        updatedAt: now,
      };
      const session = this.projectSessions.complete(acquisition, task);
      await this.writeTaskContract(task);
      this.registerTaskContext(task);
      const codexTui = await this.launchTuiForTask(task, runtime, session, true);
      const event = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId: runtime.id,
        codexThreadId: threadId,
        codexTurnId: null,
        eventType: "task_opened",
        payload: {
          type: "task_opened",
          title: task.title,
          runtimeEndpoint: runtime.endpoint,
          codexThreadId: threadId,
          projectSessionId: session.id,
          sessionGeneration: session.generation,
        },
      });
      await this.logger.append("tasks", task.id, event);

      return this.toTaskOpenResult(task, runtime, session, codexTui, "opened");
    } catch (error) {
      this.projectSessions.fail(acquisition);
      throw error;
    }
  }

  async sendTask(input: TaskSendInput): Promise<{
    taskId: string;
    runtimeHostId: string;
    codexThreadId: string;
    turnId: string;
    status: "running" | "awaiting_approval";
  }> {
    const task = this.mustGetTask(input.taskId);
    if (input.ackRevision !== undefined) {
      this.acknowledgeAttention(task.id, input.ackRevision);
    }
    const pendingAttention = this.getPendingAttention(task.id);
    if (pendingAttention) {
      throw new Error(
        `Task has unacknowledged ${pendingAttention.attention.kind} attention at revision ${pendingAttention.attention.revision}; consume it before starting another turn.`,
      );
    }
    const projectKey = canonicalizeProjectRoot(task.projectRoot).projectKey;
    const activeSession =
      this.store.getProjectSessionByKey(projectKey) ??
      this.store.activateProjectSessionForTask(task);
    if (activeSession.activeTaskId !== task.id) {
      throw new Error(
        `taskId is not the active project session: ${task.id}; call task_open with mode=reuse to obtain the current taskId.`,
      );
    }
    const commandId = createId("queue");
    this.store.enqueueCommand(commandId, task.id, input.instruction);
    return this.queue.runExclusive(`runtime:${task.runtimeHostId}`, async () => {
      let turnStarted = false;
      try {
        const runtime = await this.runtimeHostManager.ensureExistingRuntime(task.runtimeHostId);
        const latestTurn = this.store.getLatestTurn(task.id);
        if (latestTurn && ["running", "awaiting_approval"].includes(latestTurn.status)) {
          throw new Error(`Task already has an active Codex turn: ${latestTurn.codexTurnId}`);
        }

        this.store.markCommandStarted(commandId);
        const client = await this.clientPool.getOrConnect(runtime.endpoint);
        this.bindTaskRuntimeEvents(task, runtime, client);
        await client.ensureThreadReady(
          task.codexThreadId,
          task.projectRoot,
          buildCodexDeveloperInstructions(),
        );
        this.assertTuiRunning(task, runtime, activeSession);

        const codexTurnId = await client.turnStart({
          threadId: task.codexThreadId,
          cwd: task.projectRoot,
          text: buildCodexInstruction(input.instruction, {
            runChecks: input.runChecks ?? false,
          }),
        });
        turnStarted = true;
        const now = nowIso();
        const existingTurn = this.store.getTurnByCodexTurnId(codexTurnId);
        const turn = {
          id: existingTurn?.id ?? createId("turn"),
          taskId: task.id,
          codexThreadId: task.codexThreadId,
          codexTurnId,
          status: existingTurn?.status ?? "running",
          instruction: input.instruction,
          attentionRevision: existingTurn?.attentionRevision ?? 0,
          attentionAckRevision: existingTurn?.attentionAckRevision ?? 0,
          attentionKind: existingTurn?.attentionKind ?? null,
          attentionPayload: existingTurn?.attentionPayload ?? null,
          result: existingTurn?.result ?? null,
          createdAt: existingTurn?.createdAt ?? now,
          updatedAt: now,
        };
        this.store.saveTurn(turn);
        this.registerTurnContext(runtime.id, codexTurnId, task);
        this.store.updateTaskStatus(task.id, turn.status);
        const event = this.store.appendEvent({
          taskId: task.id,
          runtimeHostId: runtime.id,
          codexThreadId: task.codexThreadId,
          codexTurnId,
          eventType: "codex_turn_started",
          payload: {
            type: "codex_turn_started",
            codexTurnId,
            nextAction: "task_status",
          },
        });
        await this.logger.append("tasks", task.id, event);
        this.store.markCommandFinished(commandId);

        return {
          taskId: task.id,
          runtimeHostId: runtime.id,
          codexThreadId: task.codexThreadId,
          turnId: codexTurnId,
          status: turn.status === "awaiting_approval" ? "awaiting_approval" : "running",
        };
      } catch (error) {
        if (turnStarted) {
          this.store.markCommandFinished(commandId);
        } else {
          this.store.markCommandFailed(commandId);
        }
        const runtime = this.store.getRuntime(task.runtimeHostId);
        const event = this.store.appendEvent({
          taskId: task.id,
          runtimeHostId: task.runtimeHostId,
          codexThreadId: task.codexThreadId,
          codexTurnId: null,
          eventType: "task_send_failed",
          payload: {
            type: "task_send_failed",
            commandId,
            runtimeEndpoint: runtime?.endpoint,
            error: error instanceof Error ? error.message : String(error),
            nextAction: "task_status",
          },
        });
        await this.logger.append("tasks", task.id, event);
        throw error;
      }
    });
  }

  async waitForAttention(
    input: TaskAwaitInput,
    signal?: AbortSignal,
    waitContext: AttentionWaitContext = {},
  ): Promise<TurnAttentionResponse> {
    const task = this.mustGetTask(input.taskId);
    const initialTurn = input.turnId
      ? this.store.getTurnByCodexTurnId(input.turnId)
      : this.store.getLatestTurn(task.id);
    if (!initialTurn || initialTurn.taskId !== task.id || !initialTurn.codexTurnId) {
      throw new Error(`Codex turn not found for task: ${input.turnId ?? input.taskId}`);
    }
    const codexTurnId = initialTurn.codexTurnId;
    if (input.ackRevision !== undefined) {
      this.acknowledgeTurnAttention(task.id, codexTurnId, input.ackRevision);
    }
    const afterRevision = Math.max(input.afterRevision ?? 0, 0);

    return new Promise<TurnAttentionResponse>((resolve, reject) => {
      let settled = false;
      let fallbackTimer: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        const waiters = this.attentionWaiters.get(codexTurnId);
        waiters?.delete(check);
        if (waiters?.size === 0) {
          this.attentionWaiters.delete(codexTurnId);
        }
        signal?.removeEventListener("abort", onAbort);
        if (fallbackTimer) {
          clearInterval(fallbackTimer);
        }
      };
      const finish = (response: TurnAttentionResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.logAttentionDelivery(task.id, {
          type: "attention_wait_resolved",
          codexTurnId,
          attentionRevision: response.attention.revision,
          attentionKind: response.attention.kind,
          requestId: waitContext.requestId,
          sessionId: waitContext.sessionId,
        });
        resolve(response);
      };
      const check = () => {
        const turn = this.store.getTurnByCodexTurnId(codexTurnId);
        const acknowledgedRevision = turn?.attentionAckRevision ?? 0;
        if (
          turn &&
          turn.taskId === task.id &&
          turn.attentionRevision > Math.max(afterRevision, acknowledgedRevision) &&
          turn.attentionKind
        ) {
          finish(this.toAttentionResponse(task, turn));
        }
      };
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.logAttentionDelivery(task.id, {
          type: "attention_wait_cancelled",
          codexTurnId,
          afterRevision,
          requestId: waitContext.requestId,
          sessionId: waitContext.sessionId,
        });
        const error = new Error("Waiting for Codex attention was cancelled by the MCP client.");
        error.name = "AbortError";
        reject(error);
      };

      const waiters = this.attentionWaiters.get(codexTurnId) ?? new Set<() => void>();
      waiters.add(check);
      this.attentionWaiters.set(codexTurnId, waiters);
      this.logAttentionDelivery(task.id, {
        type: "attention_wait_registered",
        codexTurnId,
        afterRevision,
        requestId: waitContext.requestId,
        sessionId: waitContext.sessionId,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      fallbackTimer = setInterval(check, 500);
      fallbackTimer.unref();
      if (signal?.aborted) {
        onAbort();
        return;
      }
      check();
    });
  }

  async status(taskId: string, options: TaskStatusOptions = {}): Promise<Record<string, unknown>> {
    const task = this.mustGetTask(taskId);
    const runtime = this.store.getRuntime(task.runtimeHostId);
    const latestTurn = this.store.getLatestTurn(task.id);
    const pendingApproval = this.store.getPendingApproval(task.id);
    const contextUsage = this.store.getContextUsage(task.id);
    const pendingAttention = this.getPendingAttention(task.id);
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      runtime: runtime
        ? {
            status: runtime.status,
            endpoint: runtime.endpoint,
            sameWindow: runtime.status === "RUNNING",
            runtimeHostId: runtime.id,
            lastHeartbeatAt: runtime.lastHeartbeatAt,
          }
        : null,
      codex: {
        threadId: task.codexThreadId,
        turnStatus: latestTurn?.status ?? null,
        turnId: latestTurn?.codexTurnId ?? null,
        attention:
          latestTurn?.attentionKind && latestTurn.codexTurnId
            ? {
                revision: latestTurn.attentionRevision,
                kind: latestTurn.attentionKind,
                payload: latestTurn.attentionPayload,
                result: latestTurn.result,
                updatedAt: latestTurn.updatedAt,
              }
            : null,
      },
      pendingAttention,
      context: contextUsage
        ? {
            totalTokens: contextUsage.totalTokens,
            lastTotalTokens: contextUsage.lastTotalTokens,
            modelContextWindow: contextUsage.modelContextWindow,
            contextPercent: contextUsage.contextPercent,
            limitSource: contextUsage.limitSource,
            warning:
              contextUsage.contextPercent !== null &&
              contextUsage.contextPercent >= CONTEXT_STATUS_WARNING_PERCENT,
            nearLimit:
              contextUsage.contextPercent !== null &&
              contextUsage.contextPercent >= CONTEXT_NEAR_LIMIT_PERCENT,
            nextAction:
              contextUsage.contextPercent !== null &&
              contextUsage.contextPercent >= CONTEXT_NEAR_LIMIT_PERCENT
                ? "task_compact"
                : undefined,
            updatedAt: contextUsage.updatedAt,
          }
        : null,
      pendingApproval:
        pendingApproval && !options.includeApprovalPayload
          ? summarizeApproval(pendingApproval)
          : pendingApproval,
      queue: this.store.getQueueSnapshot(task.id),
    };
  }

  async events(input: TaskEventsInput): Promise<{
    taskId: string;
    runtimeHostId: string;
    codexThreadId: string;
    events: Array<EventRecord | EventSummary>;
    returned: number;
    nextAfterSeq: number | null;
    hasMore: boolean;
  }> {
    const task = this.mustGetTask(input.taskId);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
    const queriedEvents =
      input.afterSeq === undefined
        ? this.store.listUndeliveredEvents(input.taskId, limit + 1)
        : this.store.listEvents(input.taskId, input.afterSeq, limit + 1);
    const hasMore = queriedEvents.length > limit;
    const events = queriedEvents.slice(0, limit);
    if (input.markDelivered ?? true) {
      this.store.markEventsDelivered(events.map((event) => event.seq));
    }
    return {
      taskId: task.id,
      runtimeHostId: task.runtimeHostId,
      codexThreadId: task.codexThreadId,
      events: input.includePayload ? events : events.map(summarizeEvent),
      returned: events.length,
      nextAfterSeq: events.at(-1)?.seq ?? input.afterSeq ?? null,
      hasMore,
    };
  }

  async listTasks(input: TaskListInput): Promise<{
    tasks: Array<{
      taskId: string;
      title: string;
      projectRoot: string;
      status: string;
      runtimeHostId: string;
      codexThreadId: string;
      createdAt: string;
      updatedAt: string;
    }>;
    returned: number;
  }> {
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const tasks = this.store.listTasks({
      projectRoot: input.projectRoot,
      status: input.status,
      limit,
    });
    return {
      tasks: tasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        projectRoot: task.projectRoot,
        status: task.status,
        runtimeHostId: task.runtimeHostId,
        codexThreadId: task.codexThreadId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
      returned: tasks.length,
    };
  }

  async diff(input: TaskDiffInput | string, includePatch = false): Promise<unknown> {
    const options = typeof input === "string" ? { taskId: input, includePatch } : input;
    const task = this.mustGetTask(options.taskId);
    const result = await this.diffService.diffTask(task, options);
    const pending = this.store.getLatestPendingAttention(task.id);
    if (pending?.codexTurnId && pending.attentionKind === "completed") {
      this.acknowledgeTurnAttention(task.id, pending.codexTurnId, pending.attentionRevision);
    }
    return result;
  }

  async decideApproval(input: ApprovalDecisionInput): Promise<{
    taskId: string;
    approvalId: string;
    decision: "approve" | "deny";
    status: "resolved";
    turnId: string | null;
    attentionRevision: number;
  }> {
    return this.queue.runExclusive(`approval:${input.approvalId}`, async () => {
      const task = this.mustGetTask(input.taskId);
      const approval = this.store.getApproval(input.approvalId);
      if (!approval || approval.taskId !== task.id) {
        throw new Error(`approvalId not found for task: ${input.approvalId}`);
      }
      if (approval.decision) {
        throw new Error(`approvalId already resolved: ${input.approvalId}`);
      }
      const approvalTurn = approval.codexTurnId
        ? this.store.getTurnByCodexTurnId(approval.codexTurnId)
        : null;
      const runtime = await this.runtimeHostManager.ensureExistingRuntime(task.runtimeHostId);
      const client = await this.clientPool.getOrConnect(runtime.endpoint);
      await client.decideApproval({
        codexRequestId: approval.codexRequestId,
        approvalKind: approval.kind,
        decision: input.decision,
        reason: input.reason,
        payload: approval.payload,
      });
      const resolved = this.store.resolveApprovalAndResumeTurn(
        input.approvalId,
        input.decision,
        "task_orchestrator",
        input.reason,
        {
          taskId: task.id,
          runtimeHostId: runtime.id,
          codexThreadId: task.codexThreadId,
          codexTurnId: approval.codexTurnId,
          eventType: "approval_resolved",
          payload: {
            type: "approval_resolved",
            approvalId: approval.id,
            decision: input.decision,
            reason: input.reason,
          },
        },
      );
      if (approvalTurn?.codexTurnId) {
        this.acknowledgeTurnAttention(
          task.id,
          approvalTurn.codexTurnId,
          approvalTurn.attentionRevision,
        );
      }
      await this.logger.append("approvals", approval.id, resolved.event);
      await this.logger.append("tasks", task.id, resolved.event);
      return {
        taskId: task.id,
        approvalId: approval.id,
        decision: input.decision,
        status: "resolved",
        turnId: resolved.turn?.codexTurnId ?? approval.codexTurnId,
        attentionRevision: approvalTurn?.attentionRevision ?? 0,
      };
    });
  }

  private attachRuntimeEvents(runtime: RuntimeHostRecord, client: CodexAppServerClient): void {
    if (this.attachedClients.has(client)) {
      return;
    }
    this.attachedClients.add(client);
    client.on("notification", (notification: CodexNotification) => {
      void this.handleNotification(runtime, notification).catch((error: unknown) => {
        void this.logger.append("runtime", runtime.id, {
          type: "codex_event_handling_failed",
          runtimeId: runtime.id,
          error: error instanceof Error ? error.message : String(error),
          notification,
        });
      });
    });
    client.on("serverRequest", (request: CodexServerRequest) => {
      void this.handleServerRequest(runtime, request).catch((error: unknown) => {
        void this.logger.append("runtime", runtime.id, {
          type: "codex_server_request_handling_failed",
          runtimeId: runtime.id,
          error: error instanceof Error ? error.message : String(error),
          request,
        });
      });
    });
  }

  private async reuseProjectSession(
    acquisition: ProjectSessionAcquisition,
  ): Promise<TaskOpenResult> {
    const session = acquisition.session;
    if (!session.activeTaskId || !session.codexThreadId) {
      throw new Error(`Active project session has no task/thread binding: ${session.id}`);
    }
    const task = this.store.getTask(session.activeTaskId);
    if (!task || task.codexThreadId !== session.codexThreadId) {
      throw new Error(`Active project session references an invalid task: ${session.id}`);
    }
    const runtime = await this.runtimeHostManager.ensureExistingRuntime(task.runtimeHostId);
    const client = await this.clientPool.getOrConnect(runtime.endpoint);
    this.bindTaskRuntimeEvents(task, runtime, client);
    await client.ensureThreadReady(
      task.codexThreadId,
      task.projectRoot,
      buildCodexDeveloperInstructions(),
    );
    this.store.updateProjectSessionRuntime(session.id, runtime.id);
    const refreshedSession = this.store.getProjectSessionById(session.id) ?? {
      ...session,
      runtimeHostId: runtime.id,
      status: "ACTIVE" as const,
    };
    const codexTui = await this.launchTuiForTask(task, runtime, refreshedSession, true);
    const event = this.store.appendEvent({
      taskId: task.id,
      runtimeHostId: runtime.id,
      codexThreadId: task.codexThreadId,
      codexTurnId: null,
      eventType: "task_reused",
      payload: {
        type: "task_reused",
        projectSessionId: refreshedSession.id,
        sessionGeneration: refreshedSession.generation,
        runtimeEndpoint: runtime.endpoint,
        codexThreadId: task.codexThreadId,
      },
    });
    await this.logger.append("tasks", task.id, event);
    return this.toTaskOpenResult(task, runtime, refreshedSession, codexTui, "reused");
  }

  private async writeTaskContract(task: TaskRecord): Promise<void> {
    try {
      const taskLogsDir = path.join(this.bridgeConfig.logsDir, "tasks");
      const requirements =
        typeof task.requirements === "string"
          ? task.requirements
          : ["```json", JSON.stringify(task.requirements, null, 2), "```"].join("\n");
      const acceptanceCriteria = task.acceptanceCriteria
        .map((criterion) =>
          `- ${typeof criterion === "string" ? criterion : JSON.stringify(criterion)}`,
        )
        .join("\n");
      const contract = [
        `# ${task.title}`,
        "",
        "## Metadata",
        "",
        `- Project Root: ${task.projectRoot}`,
        `- Task Id: ${task.id}`,
        `- Runtime Host Id: ${task.runtimeHostId}`,
        `- Codex Thread Id: ${task.codexThreadId}`,
        `- Created At: ${task.createdAt}`,
        "",
        "## Requirements",
        "",
        requirements,
        "",
        "## Acceptance Criteria",
        "",
        acceptanceCriteria,
        "",
      ].join("\n");
      await fs.mkdir(taskLogsDir, { recursive: true });
      await fs.writeFile(path.join(taskLogsDir, `${task.id}.md`), contract, "utf8");
    } catch (error) {
      await this.logger
        .append("tasks", task.id, {
          type: "task_contract_write_failed",
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
  }

  private toTaskOpenResult(
    task: TaskRecord,
    runtime: RuntimeHostRecord,
    session: ProjectSessionRecord,
    codexTui: CodexTuiWindowResult,
    status: "opened" | "reused",
  ): TaskOpenResult {
    const latestTurn = this.store.getLatestTurn(task.id);
    const pendingAttention = this.getPendingAttention(task.id);
    const nextAction =
      pendingAttention?.attention.kind === "completed"
        ? "task_diff"
        : pendingAttention?.attention.kind === "approval"
          ? "approval_decide"
          : pendingAttention && ["failed", "interrupted"].includes(pendingAttention.attention.kind)
            ? "task_send"
        : pendingAttention
          ? "task_await"
          : latestTurn && ["running", "awaiting_approval"].includes(latestTurn.status)
            ? "task_await"
            : task.status === "waiting_review"
              ? "task_diff"
              : "task_send";
    return {
      taskId: task.id,
      runtimeHostId: runtime.id,
      runtimeEndpoint: runtime.endpoint,
      codexThreadId: task.codexThreadId,
      projectSessionId: session.id,
      sessionGeneration: session.generation,
      codexTui: {
        launched: codexTui.launched,
        mode: codexTui.mode,
        pid: codexTui.pid,
        reason: codexTui.reason,
      },
      status,
      nextAction,
      requiredAckRevision:
        pendingAttention && nextAction === "task_send"
          ? pendingAttention.attention.revision
          : undefined,
      pendingAttention: pendingAttention ?? undefined,
    };
  }

  getPendingAttention(taskId: string): TurnAttentionResponse | null {
    const task = this.mustGetTask(taskId);
    const turn = this.store.getLatestPendingAttention(task.id);
    return turn ? this.toAttentionResponse(task, turn) : null;
  }

  acknowledgeAttention(taskId: string, revision: number): TurnAttentionResponse | null {
    const task = this.mustGetTask(taskId);
    const turn = this.store.getLatestPendingAttention(task.id);
    if (!turn?.codexTurnId) {
      return null;
    }
    const acknowledged = this.acknowledgeTurnAttention(task.id, turn.codexTurnId, revision);
    return acknowledged ? this.toAttentionResponse(task, acknowledged) : null;
  }

  private acknowledgeTurnAttention(
    taskId: string,
    codexTurnId: string,
    revision: number,
  ): TurnRecord | null {
    const current = this.store.getTurnByCodexTurnId(codexTurnId);
    if (current && revision > current.attentionRevision) {
      throw new Error(
        `Cannot acknowledge future attention revision ${revision}; current revision is ${current.attentionRevision}.`,
      );
    }
    const acknowledged = this.store.acknowledgeTurnAttention(codexTurnId, revision);
    if (acknowledged) {
      this.logAttentionDelivery(taskId, {
        type: "attention_acknowledged",
        codexTurnId,
        requestedRevision: revision,
        acknowledgedRevision: acknowledged.attentionAckRevision,
        attentionKind: acknowledged.attentionKind,
      });
    }
    return acknowledged;
  }

  private async launchTuiForTask(
    task: TaskRecord,
    runtime: RuntimeHostRecord,
    session: ProjectSessionRecord,
    required = false,
  ): Promise<{
    launched: boolean;
    mode: "off" | "remote" | "resume";
    pid: number | null;
    reason?: string;
  }> {
    try {
      const result = await this.tuiWindowManager.ensure(
        {
          sessionId: session.id,
          sessionGeneration: session.generation,
          runtimeId: runtime.id,
          projectRoot: task.projectRoot,
          endpoint: runtime.endpoint,
          threadId: task.codexThreadId,
        },
      );
      if (required && result.mode !== "off" && result.pid === null) {
        throw new Error("Codex TUI launcher did not return a process id.");
      }
      const event = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId: runtime.id,
        codexThreadId: task.codexThreadId,
        codexTurnId: null,
        eventType: result.launched ? "codex_tui_window_launched" : "codex_tui_window_skipped",
        payload: {
          type: result.launched ? "codex_tui_window_launched" : "codex_tui_window_skipped",
          mode: result.mode,
          pid: result.pid,
          scriptPath: result.scriptPath,
          reason: result.reason,
          projectSessionId: session.id,
          sessionGeneration: session.generation,
        },
      });
      await this.logger.append("tasks", task.id, event);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const event = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId: runtime.id,
        codexThreadId: task.codexThreadId,
        codexTurnId: null,
        eventType: "codex_tui_window_failed",
        payload: {
          type: "codex_tui_window_failed",
          reason,
        },
      });
      await this.logger.append("tasks", task.id, event);
      if (required) {
        throw new Error(`Codex TUI is required for the project session: ${reason}`);
      }
      return {
        launched: false,
        mode: "off",
        pid: null,
        reason,
      };
    }
  }

  private assertTuiRunning(
    task: TaskRecord,
    runtime: RuntimeHostRecord,
    session: ProjectSessionRecord,
  ): void {
    const result = this.tuiWindowManager.getRunning({
      sessionId: session.id,
      sessionGeneration: session.generation,
      runtimeId: runtime.id,
      projectRoot: task.projectRoot,
      endpoint: runtime.endpoint,
      threadId: task.codexThreadId,
    });
    if (result.mode !== "off" && result.pid === null) {
      throw new Error(
        "Codex TUI is not running for this project session; call task_open with mode=reuse to restore the visible session before task_send.",
      );
    }
  }

  private async handleServerRequest(
    runtime: RuntimeHostRecord,
    request: CodexServerRequest,
  ): Promise<void> {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const codexThreadId = extractThreadId(params);
    const codexTurnId = extractTurnId(params);
    const context = this.resolveContext(runtime.id, codexThreadId, codexTurnId);
    if (!context) {
      await this.logger.append("runtime", runtime.id, {
        type: "unbound_codex_server_request",
        runtimeId: runtime.id,
        request,
      });
      return;
    }

    const task = this.store.getTask(context.taskId);
    if (!task) {
      return;
    }

    if (isApprovalServerRequest(request)) {
      const approval = approvalFromServerRequest(request, {
        taskId: task.id,
        runtimeHostId: runtime.id,
        codexThreadId: task.codexThreadId,
        codexTurnId,
      });
      await this.recordApprovalRequest(task, approval);
      return;
    }

    const event = this.store.appendEvent({
      taskId: task.id,
      runtimeHostId: runtime.id,
      codexThreadId: task.codexThreadId,
      codexTurnId,
      eventType: "codex_server_request",
      payload: {
        type: "codex_server_request",
        method: request.method,
        requestId: request.id,
        params,
      },
    });
    await this.logger.append("tasks", task.id, event);
  }

  private async handleNotification(
    runtime: RuntimeHostRecord,
    notification: CodexNotification,
  ): Promise<void> {
    const normalized = normalizeCodexEvent(notification);
    const context = this.resolveContext(runtime.id, normalized.codexThreadId, normalized.codexTurnId);
    if (!context) {
      await this.logger.append("runtime", runtime.id, {
        type: "unbound_codex_event",
        runtimeId: runtime.id,
        notification,
      });
      return;
    }

    const task = this.store.getTask(context.taskId);
    if (!task) {
      return;
    }

    if (isApprovalRequest(notification)) {
      const approval = approvalFromNotification(notification, {
        taskId: task.id,
        runtimeHostId: runtime.id,
        codexThreadId: task.codexThreadId,
        codexTurnId: normalized.codexTurnId,
      });
      await this.recordApprovalRequest(task, approval);
      return;
    }

    if (normalized.eventType === "codex_turn_completed" && normalized.codexTurnId) {
      const turnPayload = toRecord(toRecord(notification.params).turn);
      const appServerStatus = String(turnPayload.status ?? "failed");
      const turnStatus = ["completed", "failed", "interrupted"].includes(appServerStatus)
        ? appServerStatus
        : "failed";
      const attentionPayload = {
        type: "codex_turn_completed",
        status: turnStatus,
        error: turnStatus === "failed" ? turnPayload.error ?? null : null,
        nextAction: turnStatus === "completed" ? "task_diff" : "task_status",
      };
      const recorded = this.store.recordTurnAttention({
        taskId: task.id,
        codexTurnId: normalized.codexTurnId,
        turnStatus,
        taskStatus: turnStatus === "completed" ? "waiting_review" : turnStatus,
        attentionKind: turnStatus,
        attentionPayload,
        event: {
          taskId: task.id,
          runtimeHostId: runtime.id,
          codexThreadId: task.codexThreadId,
          codexTurnId: normalized.codexTurnId,
          eventType: normalized.eventType,
          payload: attentionPayload,
        },
      });
      if (recorded.event) {
        await this.logger.append("tasks", task.id, recorded.event);
      }
      if (recorded.turn) {
        this.logAttentionDelivery(task.id, {
          type: "attention_persisted",
          codexTurnId: recorded.turn.codexTurnId,
          attentionRevision: recorded.turn.attentionRevision,
          attentionKind: recorded.turn.attentionKind,
        });
      }
      this.signalAttention(normalized.codexTurnId);
      return;
    }

    if (notification.method === "item/completed" && normalized.codexTurnId) {
      const item = toRecord(notification.params?.item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        this.store.updateTurnResult(normalized.codexTurnId, {
          finalMessage: item.text,
        });
      }
    }

    if (notification.method === "thread/tokenUsage/updated") {
      await this.updateContextUsage(runtime, task, notification.params);
      return;
    }

    if (!shouldPersistNotification(notification.method)) {
      return;
    }

    const event = this.store.appendEvent({
      taskId: task.id,
      runtimeHostId: runtime.id,
      codexThreadId: task.codexThreadId,
      codexTurnId: normalized.codexTurnId,
      eventType: normalized.eventType,
      payload: normalized.payload,
    });
    await this.logger.append("tasks", task.id, event);
  }

  private async recordApprovalRequest(
    task: TaskRecord,
    approval: ApprovalRecord,
  ): Promise<void> {
    const payload = {
      type: "approval_requested",
      approvalId: approval.id,
      codexRequestId: approval.codexRequestId,
      kind: approval.kind,
      command: approval.command,
      cwd: approval.cwd,
      reason: approval.reason,
      riskSummary: approval.riskSummary,
      nextAction: "approval_decide",
    };
    const recorded = this.store.recordApprovalAttention(approval, {
      taskId: task.id,
      runtimeHostId: approval.runtimeHostId,
      codexThreadId: task.codexThreadId,
      codexTurnId: approval.codexTurnId,
      eventType: "approval_requested",
      payload,
    });
    if (!recorded.created || !recorded.event) {
      return;
    }
    await this.logger.append("approvals", recorded.approval.id, recorded.approval);
    await this.logger.append("tasks", task.id, recorded.event);
    if (recorded.turn?.codexTurnId) {
      this.signalAttention(recorded.turn.codexTurnId);
    }
  }

  private async updateContextUsage(
    runtime: RuntimeHostRecord,
    task: TaskRecord,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const snapshot = extractTokenUsageSnapshot(params);
    if (!snapshot) {
      return;
    }
    const previous = this.store.getContextUsage(task.id);
    const limit = snapshot.modelContextWindow ?? task.tokenBudget;
    const codexTurnId = extractTurnId(params);
    const contextPercent = snapshot.modelContextWindow
      ? contextWindowPercent(snapshot.lastTotalTokens, snapshot.modelContextWindow)
      : cumulativeBudgetPercent(snapshot.totalTokens, task.tokenBudget);
    const limitSource = snapshot.modelContextWindow
      ? "model_context_window"
      : task.tokenBudget
        ? "task_token_budget"
        : null;
    this.store.saveContextUsage({
      taskId: task.id,
      runtimeHostId: runtime.id,
      codexThreadId: task.codexThreadId,
      codexTurnId,
      totalTokens: snapshot.totalTokens,
      inputTokens: snapshot.inputTokens,
      cachedInputTokens: snapshot.cachedInputTokens,
      outputTokens: snapshot.outputTokens,
      reasoningOutputTokens: snapshot.reasoningOutputTokens,
      lastTotalTokens: snapshot.lastTotalTokens,
      modelContextWindow: snapshot.modelContextWindow,
      contextPercent,
      limitSource,
      nearLimitEmitted: previous?.nearLimitEmitted ?? false,
      updatedAt: nowIso(),
    });

    if (
      contextPercent !== null &&
      contextPercent >= CONTEXT_NEAR_LIMIT_PERCENT &&
      !previous?.nearLimitEmitted
    ) {
      const event = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId: runtime.id,
        codexThreadId: task.codexThreadId,
        codexTurnId,
        eventType: "context_near_limit",
        payload: {
          type: "context_near_limit",
          totalTokens: snapshot.totalTokens,
          lastTotalTokens: snapshot.lastTotalTokens,
          limit,
          contextPercent,
          limitSource,
          nextAction: "task_compact",
        },
      });
      this.store.markContextNearLimitEmitted(task.id);
      await this.logger.append("tasks", task.id, event);
    }
  }

  private resolveContext(
    runtimeHostId: string,
    codexThreadId: string | null,
    codexTurnId: string | null,
  ): TaskContext | null {
    if (codexThreadId) {
      const key = this.contextKey(runtimeHostId, codexThreadId);
      const local = this.threadContexts.get(key);
      if (local) {
        return local;
      }
      const task = this.store.getTaskByThread(runtimeHostId, codexThreadId);
      if (task) {
        this.registerTaskContext(task);
        return {
          taskId: task.id,
          runtimeHostId,
          codexThreadId,
        };
      }
    }

    if (codexTurnId) {
      const key = this.contextKey(runtimeHostId, codexTurnId);
      const local = this.turnContexts.get(key);
      if (local) {
        return local;
      }
      const turn = this.store.getTurnByCodexTurnId(codexTurnId);
      if (turn) {
        const task = this.store.getTask(turn.taskId);
        if (task) {
          this.registerTurnContext(runtimeHostId, codexTurnId, task);
          return {
            taskId: task.id,
            runtimeHostId,
            codexThreadId: task.codexThreadId,
          };
        }
      }
    }

    return null;
  }

  private registerTaskContext(task: TaskRecord): void {
    this.threadContexts.set(this.contextKey(task.runtimeHostId, task.codexThreadId), {
      taskId: task.id,
      runtimeHostId: task.runtimeHostId,
      codexThreadId: task.codexThreadId,
    });
  }

  private registerTurnContext(runtimeHostId: string, codexTurnId: string, task: TaskRecord): void {
    this.turnContexts.set(this.contextKey(runtimeHostId, codexTurnId), {
      taskId: task.id,
      runtimeHostId,
      codexThreadId: task.codexThreadId,
    });
  }

  private toAttentionResponse(task: TaskRecord, turn: TurnRecord): TurnAttentionResponse {
    return {
      taskId: task.id,
      runtimeHostId: task.runtimeHostId,
      codexThreadId: task.codexThreadId,
      turnId: turn.codexTurnId ?? "",
      status: turn.status,
      attention: {
        revision: turn.attentionRevision,
        kind: turn.attentionKind ?? turn.status,
        payload: turn.attentionPayload,
        result: turn.result,
        updatedAt: turn.updatedAt,
      },
    };
  }

  private signalAttention(codexTurnId: string): void {
    const turn = this.store.getTurnByCodexTurnId(codexTurnId);
    const waiters = [...(this.attentionWaiters.get(codexTurnId) ?? [])];
    if (turn) {
      this.logAttentionDelivery(turn.taskId, {
        type: "attention_wait_signaled",
        codexTurnId,
        attentionRevision: turn.attentionRevision,
        attentionKind: turn.attentionKind,
        waiterCount: waiters.length,
      });
    }
    for (const waiter of waiters) {
      waiter();
    }
  }

  private logAttentionDelivery(taskId: string, payload: Record<string, unknown>): void {
    void this.logger.append("tasks", taskId, payload).catch(() => undefined);
  }

  private contextKey(runtimeHostId: string, id: string): string {
    return `${runtimeHostId}:${id}`;
  }

  private mustGetTask(taskId: string): TaskRecord {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`taskId not found. Call task_open first: ${taskId}`);
    }
    return task;
  }

  private async recoverInterruptedQueue(): Promise<void> {
    await Promise.all(
      this.store.listRuntimes().map(async (runtime) => {
        try {
          const alive = await isHttpReady(
            runtime.endpoint,
            this.bridgeConfig.runtimeReconnectTimeoutMs,
          );
          if (alive) {
            this.store.markRuntimeHeartbeat(runtime.id);
            const client = await this.clientPool.getOrConnect(runtime.endpoint);
            await this.orphanApprovalsFromPreviousConnection(runtime);
            for (const task of this.store.listOpenTasksForRuntime(runtime.id)) {
              this.bindTaskRuntimeEvents(task, runtime, client);
              await this.reconcileTaskAfterCoreRestart(task, runtime, client).catch(
                async (error: unknown) => {
                  await this.logger.append("runtime", runtime.id, {
                    type: "task_startup_reconciliation_failed",
                    runtimeId: runtime.id,
                    taskId: task.id,
                    codexThreadId: task.codexThreadId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                },
              );
            }
            return;
          }
          await this.runtimeHostManager.interruptRuntimeDependents(
            runtime.id,
            "Bridge startup could not reach this Runtime Host; its running work was marked interrupted.",
          );
        } catch (error) {
          await this.logger.append("runtime", runtime.id, {
            type: "runtime_startup_recovery_failed",
            runtimeId: runtime.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  private async orphanApprovalsFromPreviousConnection(runtime: RuntimeHostRecord): Promise<void> {
    const reason =
      "Approval was orphaned because Bridge Core restarted and the App Server request belongs to the previous connection.";
    const orphaned = this.store.orphanPendingApprovalsForRuntime(runtime.id, reason);
    for (const approval of orphaned.approvals) {
      const event = this.store.appendEvent({
        taskId: approval.taskId,
        runtimeHostId: runtime.id,
        codexThreadId: approval.codexThreadId,
        codexTurnId: approval.codexTurnId,
        eventType: "approval_orphaned",
        payload: {
          type: "approval_orphaned",
          approvalId: approval.id,
          decision: approval.decision,
          decidedBy: approval.decidedBy,
          decisionReason: approval.decisionReason,
          resolvedAt: approval.resolvedAt,
          nextAction: "task_recover",
        },
      });
      await this.logger.append("approvals", approval.id, event);
      await this.logger.append("tasks", approval.taskId, event);
    }
    for (const turn of orphaned.turns) {
      if (!turn.codexTurnId) {
        continue;
      }
      const event = this.store.appendEvent({
        taskId: turn.taskId,
        runtimeHostId: runtime.id,
        codexThreadId: turn.codexThreadId,
        codexTurnId: turn.codexTurnId,
        eventType: "codex_turn_interrupted",
        payload: {
          type: "codex_turn_interrupted",
          codexTurnId: turn.codexTurnId,
          reason,
          nextAction: "task_recover",
        },
      });
      await this.logger.append("tasks", turn.taskId, event);
      this.signalAttention(turn.codexTurnId);
    }
  }

  private async reconcileTaskAfterCoreRestart(
    task: TaskRecord,
    runtime: RuntimeHostRecord,
    client: CodexAppServerClient,
  ): Promise<void> {
    const localTurn = this.store.getLatestTurn(task.id);
    if (!localTurn?.codexTurnId || !["running", "awaiting_approval"].includes(localTurn.status)) {
      return;
    }

    await client.ensureThreadReady(
      task.codexThreadId,
      task.projectRoot,
      buildCodexDeveloperInstructions(),
    );
    const thread = await client.readThread(task.codexThreadId);
    const remoteTurn = thread.turns.find((turn) => turn.id === localTurn.codexTurnId);
    if (remoteTurn?.status === "inProgress") {
      if (
        thread.status.type === "active" &&
        thread.status.activeFlags.includes("waitingOnApproval")
      ) {
        await this.recordReconciledTurnAttention(task, runtime, localTurn.codexTurnId, {
          turnStatus: "interrupted",
          taskStatus: "interrupted",
          attentionKind: "interrupted",
          error:
            "Codex is waiting on an approval request that was owned by the previous Bridge connection.",
          nextAction: "task_recover",
        });
      }
      return;
    }

    if (remoteTurn && ["completed", "failed", "interrupted"].includes(remoteTurn.status)) {
      await this.recordReconciledTurnAttention(task, runtime, localTurn.codexTurnId, {
        turnStatus: remoteTurn.status,
        taskStatus: remoteTurn.status === "completed" ? "waiting_review" : remoteTurn.status,
        attentionKind: remoteTurn.status,
        error: remoteTurn.error,
        nextAction: remoteTurn.status === "completed" ? "task_diff" : "task_status",
      });
      return;
    }

    if (thread.status.type === "idle" || thread.status.type === "systemError") {
      await this.recordReconciledTurnAttention(task, runtime, localTurn.codexTurnId, {
        turnStatus: "interrupted",
        taskStatus: "interrupted",
        attentionKind: "interrupted",
        error: "Codex no longer reports the locally active turn after Bridge Core restart.",
        nextAction: "task_recover",
      });
    }
  }

  private async recordReconciledTurnAttention(
    task: TaskRecord,
    runtime: RuntimeHostRecord,
    codexTurnId: string,
    input: {
      turnStatus: string;
      taskStatus: string;
      attentionKind: string;
      error: unknown;
      nextAction: string;
    },
  ): Promise<void> {
    const payload = {
      type: "codex_turn_reconciled",
      status: input.turnStatus,
      error: input.error,
      nextAction: input.nextAction,
    };
    const recorded = this.store.recordTurnAttention({
      taskId: task.id,
      codexTurnId,
      turnStatus: input.turnStatus,
      taskStatus: input.taskStatus,
      attentionKind: input.attentionKind,
      attentionPayload: payload,
      event: {
        taskId: task.id,
        runtimeHostId: runtime.id,
        codexThreadId: task.codexThreadId,
        codexTurnId,
        eventType: "codex_turn_reconciled",
        payload,
      },
    });
    if (recorded.event) {
      await this.logger.append("tasks", task.id, recorded.event);
      this.signalAttention(codexTurnId);
    }
  }
}

function summarizeEvent(event: EventRecord): EventSummary {
  const payload = toRecord(event.payload);
  const details = summarizeDetails(event.eventType, payload);
  return {
    seq: event.seq,
    codexTurnId: event.codexTurnId,
    eventType: event.eventType,
    summary: summarizeMessage(event.eventType, payload),
    nextAction: payload.nextAction,
    details: Object.keys(details).length > 0 ? details : undefined,
    createdAt: event.createdAt,
  };
}

function summarizeApproval(approval: ApprovalRecord): ApprovalSummary {
  return {
    id: approval.id,
    codexTurnId: approval.codexTurnId,
    kind: approval.kind,
    command: approval.command,
    cwd: approval.cwd,
    reason: approval.reason,
    riskSummary: approval.riskSummary,
    createdAt: approval.createdAt,
  };
}

function summarizeMessage(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case "task_opened":
      return "Task opened and bound to one Codex thread.";
    case "codex_turn_started":
      return "Codex turn started on the existing task thread.";
    case "codex_turn_completed":
      return "Codex completed a turn; the task orchestrator should review the diff.";
    case "codex_turn_interrupted":
      return "A running Codex turn was interrupted after its Runtime Host became unreachable.";
    case "approval_requested":
      return `Codex requested ${String(payload.kind ?? "an")} approval.`;
    case "approval_resolved":
      return `Approval was ${String(payload.decision ?? "resolved")}.`;
    case "approval_orphaned":
      return "A pending approval was orphaned after its Runtime Host connection was lost.";
    case "codex_thread_token_usage_updated":
      return "Codex reported an updated token usage snapshot.";
    case "context_near_limit":
      return "Codex context is near the configured limit; compact the task thread.";
    case "context_compact_started":
      return "Codex thread compaction started.";
    case "task_recovered":
      return "Task recovered on the known Codex thread.";
    case "task_send_failed":
      return "Sending the instruction to Codex failed before a usable result was returned.";
    case "task_command_interrupted":
      return "A previously running queued command was marked interrupted after Bridge restart.";
    case "codex_tui_window_launched":
      return "Codex remote TUI window was launched for this task thread.";
    case "codex_tui_window_skipped":
      return "Codex remote TUI window was skipped.";
    case "codex_tui_window_failed":
      return "Codex remote TUI window failed to launch.";
    default:
      return eventType.replace(/^codex_/, "Codex event: ");
  }
}

function summarizeDetails(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (eventType === "approval_requested") {
    return pick(payload, ["approvalId", "codexRequestId", "kind", "command", "cwd", "riskSummary"]);
  }
  if (eventType === "approval_orphaned") {
    return pick(payload, [
      "approvalId",
      "decision",
      "decidedBy",
      "decisionReason",
      "resolvedAt",
    ]);
  }
  if (eventType === "context_near_limit") {
    return pick(payload, [
      "totalTokens",
      "lastTotalTokens",
      "limit",
      "contextPercent",
      "limitSource",
    ]);
  }
  if (eventType === "codex_thread_token_usage_updated") {
    const tokenUsage = toRecord(payload.tokenUsage);
    return {
      tokenUsage: pick(tokenUsage, ["totalTokens", "modelContextWindow", "lastTotalTokens"]),
    };
  }
  if (eventType === "task_send_failed") {
    return pick(payload, ["commandId", "runtimeEndpoint", "error"]);
  }
  if (eventType === "codex_turn_interrupted") {
    return pick(payload, ["codexTurnId", "interruptedAt"]);
  }
  if (eventType === "task_command_interrupted") {
    return pick(payload, ["commandId", "startedAt"]);
  }
  if (
    eventType === "codex_tui_window_launched" ||
    eventType === "codex_tui_window_skipped" ||
    eventType === "codex_tui_window_failed"
  ) {
    return pick(payload, ["mode", "pid", "scriptPath", "reason"]);
  }
  return pick(payload, ["codexTurnId", "runtimeEndpoint", "codexThreadId"]);
}

function shouldPersistNotification(method: string): boolean {
  return method === "error" || method === "warning" || method === "thread/compacted";
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) {
      picked[key] = source[key];
    }
  }
  return picked;
}

function contextWindowPercent(
  lastTotalTokens: number | null,
  modelContextWindow: number,
): number | null {
  if (lastTotalTokens === null || modelContextWindow <= CONTEXT_BASELINE_TOKENS) {
    return null;
  }
  const usableWindow = modelContextWindow - CONTEXT_BASELINE_TOKENS;
  const tokensInContext = Math.max(lastTotalTokens - CONTEXT_BASELINE_TOKENS, 0);
  const percent = (tokensInContext / usableWindow) * 100;
  return Number(Math.min(Math.max(percent, 0), 100).toFixed(2));
}

function cumulativeBudgetPercent(totalTokens: number, tokenBudget: number | null): number | null {
  return tokenBudget && tokenBudget > 0
    ? Number(((totalTokens / tokenBudget) * 100).toFixed(2))
    : null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
