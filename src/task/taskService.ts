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
import { RuntimeHostManager } from "../runtime/runtimeHostManager.js";
import { launchCodexTuiWindow } from "../runtime/tuiWindowManager.js";
import { DiffService } from "../review/diffService.js";
import { createId, createTaskId, nowIso } from "../shared/id.js";
import { JsonlLogger } from "../storage/jsonlLogger.js";
import {
  type EventRecord,
  type RuntimeHostRecord,
  type TaskCommandRecord,
  type TaskRecord,
  SqliteStore,
} from "../storage/sqlite.js";
import {
  buildCodexDeveloperInstructions,
  buildCodexInstruction,
} from "./codexInstruction.js";
import { TaskQueue } from "./taskQueue.js";

export interface TaskOpenInput {
  projectRoot: string;
  title: string;
  requirements?: unknown;
  acceptanceCriteria: unknown[];
  tokenBudget?: number;
}

export interface TaskSendInput {
  taskId: string;
  instruction: string;
  runChecks?: boolean;
}

export interface TaskEventsInput {
  taskId: string;
  afterSeq?: number;
  limit?: number;
  markDelivered?: boolean;
  includePayload?: boolean;
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
  taskId: string;
  runtimeHostId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  eventType: string;
  summary: string;
  nextAction?: unknown;
  details?: Record<string, unknown>;
  claudeDelivered: boolean;
  createdAt: string;
}

const CONTEXT_STATUS_WARNING_PERCENT = 70;
const CONTEXT_NEAR_LIMIT_PERCENT = 85;

export class TaskService {
  private readonly queue = new TaskQueue();
  private readonly attachedClients = new WeakSet<CodexAppServerClient>();
  private readonly threadContexts = new Map<string, TaskContext>();
  private readonly turnContexts = new Map<string, TaskContext>();

  constructor(
    private readonly store: SqliteStore,
    private readonly runtimeHostManager: RuntimeHostManager,
    private readonly clientPool: CodexClientPool,
    private readonly logger: JsonlLogger,
    private readonly diffService: DiffService,
    private readonly bridgeConfig: BridgeConfig = config,
  ) {
    this.recoverInterruptedQueue();
  }

  async openTask(input: TaskOpenInput): Promise<{
    taskId: string;
    runtimeHostId: string;
    runtimeEndpoint: string;
    codexThreadId: string;
    codexTui: {
      launched: boolean;
      mode: "off" | "remote" | "resume";
      pid: number | null;
      reason?: string;
    };
    status: "opened";
  }> {
    const runtime = await this.runtimeHostManager.ensureRuntimeHost(input.projectRoot);
    const client = await this.clientPool.getOrConnect(runtime.endpoint);
    this.attachRuntimeEvents(runtime, client);

    const threadId = await client.threadStart({
      cwd: input.projectRoot,
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
      id: createTaskId(input.projectRoot, input.title),
      title: input.title,
      projectRoot: input.projectRoot,
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
    this.store.saveTask(task);
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
    this.registerTaskContext(task);
    const codexTui = await this.launchTuiForTask(task, runtime);
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
      },
    });
    await this.logger.append("tasks", task.id, event);

    return {
      taskId: task.id,
      runtimeHostId: runtime.id,
      runtimeEndpoint: runtime.endpoint,
      codexThreadId: threadId,
      codexTui: {
        launched: codexTui.launched,
        mode: codexTui.mode,
        pid: codexTui.pid,
        reason: codexTui.reason,
      },
      status: "opened",
    };
  }

  async sendTask(input: TaskSendInput): Promise<{
    taskId: string;
    runtimeHostId: string;
    codexThreadId: string;
    turnId: string;
    status: "running";
  }> {
    const task = this.mustGetTask(input.taskId);
    const commandId = createId("queue");
    this.store.enqueueCommand(commandId, task.id, input.instruction);
    return this.queue.runExclusive(`runtime:${task.runtimeHostId}`, async () => {
      let turnStarted = false;
      const latestTurn = this.store.getLatestTurn(task.id);
      if (latestTurn?.status === "running") {
        this.store.markCommandFailed(commandId);
        throw new Error(`Task already has an active Codex turn: ${latestTurn.codexTurnId}`);
      }

      this.store.markCommandStarted(commandId);
      try {
        const runtime = await this.runtimeHostManager.ensureExistingRuntime(task.runtimeHostId);
        const client = await this.clientPool.getOrConnect(runtime.endpoint);
        this.attachRuntimeEvents(runtime, client);
        this.registerTaskContext(task);
        await client.ensureThreadReady(
          task.codexThreadId,
          task.projectRoot,
          buildCodexDeveloperInstructions(),
        );

        const reportPath = path.join(
          this.bridgeConfig.logsDir,
          "tasks",
          `${task.id}.report.json`,
        );
        const codexTurnId = await client.turnStart({
          threadId: task.codexThreadId,
          cwd: task.projectRoot,
          text: buildCodexInstruction(input.instruction, {
            runChecks: input.runChecks ?? false,
            reportPath,
          }),
        });
        turnStarted = true;
        const now = nowIso();
        this.store.saveTurn({
          id: createId("turn"),
          taskId: task.id,
          codexThreadId: task.codexThreadId,
          codexTurnId,
          status: "running",
          instruction: input.instruction,
          createdAt: now,
          updatedAt: now,
        });
        this.registerTurnContext(runtime.id, codexTurnId, task);
        this.store.updateTaskStatus(task.id, "running");
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
          status: "running",
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

  async status(taskId: string): Promise<Record<string, unknown>> {
    const task = this.mustGetTask(taskId);
    const runtime = this.store.getRuntime(task.runtimeHostId);
    const latestTurn = this.store.getLatestTurn(task.id);
    const pendingApproval = this.store.getPendingApproval(task.id);
    const contextUsage = this.store.getContextUsage(task.id);
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
      },
      context: contextUsage
        ? {
            totalTokens: contextUsage.totalTokens,
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
      pendingApproval,
      queue: this.store.getQueueSnapshot(task.id),
    };
  }

  async events(input: TaskEventsInput): Promise<{
    taskId: string;
    events: Array<EventRecord | EventSummary>;
    returned: number;
  }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const events =
      input.afterSeq === undefined
        ? this.store.listUndeliveredEvents(input.taskId, limit)
        : this.store.listEvents(input.taskId, input.afterSeq, limit);
    if (input.markDelivered ?? true) {
      this.store.markEventsDelivered(events.map((event) => event.seq));
    }
    return {
      taskId: input.taskId,
      events: input.includePayload ? events : events.map(summarizeEvent),
      returned: events.length,
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

  async diff(taskId: string, includePatch: boolean): Promise<unknown> {
    const task = this.mustGetTask(taskId);
    return this.diffService.diffTask(task, includePatch);
  }

  async decideApproval(input: ApprovalDecisionInput): Promise<{
    taskId: string;
    approvalId: string;
    decision: "approve" | "deny";
    status: "resolved";
  }> {
    const task = this.mustGetTask(input.taskId);
    const approval = this.store.getApproval(input.approvalId);
    if (!approval || approval.taskId !== task.id) {
      throw new Error(`approvalId not found for task: ${input.approvalId}`);
    }
    if (approval.decision) {
      throw new Error(`approvalId already resolved: ${input.approvalId}`);
    }
    const runtime = await this.runtimeHostManager.ensureExistingRuntime(task.runtimeHostId);
    const client = await this.clientPool.getOrConnect(runtime.endpoint);
    await client.decideApproval({
      codexRequestId: approval.codexRequestId,
      approvalKind: approval.kind,
      decision: input.decision,
      reason: input.reason,
      payload: approval.payload,
    });
    this.store.resolveApproval(input.approvalId, input.decision, "claude", input.reason);
    const event = this.store.appendEvent({
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
    });
    await this.logger.append("approvals", approval.id, event);
    await this.logger.append("tasks", task.id, event);
    return {
      taskId: task.id,
      approvalId: approval.id,
      decision: input.decision,
      status: "resolved",
    };
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

  private async launchTuiForTask(
    task: TaskRecord,
    runtime: RuntimeHostRecord,
  ): Promise<{
    launched: boolean;
    mode: "off" | "remote" | "resume";
    pid: number | null;
    reason?: string;
  }> {
    try {
      const result = await launchCodexTuiWindow(
        {
          runtimeId: runtime.id,
          projectRoot: task.projectRoot,
          endpoint: runtime.endpoint,
          threadId: task.codexThreadId,
        },
        this.bridgeConfig,
      );
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
      return {
        launched: false,
        mode: "off",
        pid: null,
        reason,
      };
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
      this.store.saveApproval(approval);
      const approvalEvent = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId: runtime.id,
        codexThreadId: task.codexThreadId,
        codexTurnId,
        eventType: "approval_requested",
        payload: {
          type: "approval_requested",
          approvalId: approval.id,
          codexRequestId: approval.codexRequestId,
          kind: approval.kind,
          command: approval.command,
          cwd: approval.cwd,
          reason: approval.reason,
          riskSummary: approval.riskSummary,
          nextAction: "approval_decide",
        },
      });
      await this.logger.append("approvals", approval.id, approval);
      await this.logger.append("tasks", task.id, approvalEvent);
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
      this.store.saveApproval(approval);
      const approvalEvent = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId: runtime.id,
        codexThreadId: task.codexThreadId,
        codexTurnId: normalized.codexTurnId,
        eventType: "approval_requested",
        payload: {
          type: "approval_requested",
          approvalId: approval.id,
          codexRequestId: approval.codexRequestId,
          kind: approval.kind,
          command: approval.command,
          cwd: approval.cwd,
          reason: approval.reason,
          riskSummary: approval.riskSummary,
          nextAction: "approval_decide",
        },
      });
      await this.logger.append("approvals", approval.id, approval);
      await this.logger.append("tasks", task.id, approvalEvent);
    }

    if (normalized.eventType === "codex_turn_completed" && normalized.codexTurnId) {
      this.store.updateTurnByCodexTurnId(normalized.codexTurnId, "completed");
      this.store.updateTaskStatus(task.id, "waiting_review");
    }

    if (notification.method === "thread/tokenUsage/updated") {
      await this.updateContextUsage(runtime, task, notification.params);
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
    const contextPercent =
      limit && limit > 0 ? Number(((snapshot.totalTokens / limit) * 100).toFixed(2)) : null;
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

  private recoverInterruptedQueue(): void {
    const interrupted = this.store.markRunningCommandsInterrupted();
    for (const command of interrupted) {
      const task = this.store.getTask(command.taskId);
      if (!task) {
        continue;
      }
      const event = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId: task.runtimeHostId,
        codexThreadId: task.codexThreadId,
        codexTurnId: null,
        eventType: "task_command_interrupted",
        payload: {
          type: "task_command_interrupted",
          commandId: command.id,
          startedAt: command.startedAt,
          reason:
            "Bridge restarted while this queued command was running; Claude should inspect task_status before resending.",
          nextAction: "task_status",
        },
      });
      void this.logger.append("tasks", task.id, event);
    }
  }
}

function summarizeEvent(event: EventRecord): EventSummary {
  const payload = toRecord(event.payload);
  const details = summarizeDetails(event.eventType, payload);
  return {
    seq: event.seq,
    taskId: event.taskId,
    runtimeHostId: event.runtimeHostId,
    codexThreadId: event.codexThreadId,
    codexTurnId: event.codexTurnId,
    eventType: event.eventType,
    summary: summarizeMessage(event.eventType, payload),
    nextAction: payload.nextAction,
    details: Object.keys(details).length > 0 ? details : undefined,
    claudeDelivered: event.claudeDelivered,
    createdAt: event.createdAt,
  };
}

function summarizeMessage(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case "task_opened":
      return "Task opened and bound to one Codex thread.";
    case "codex_turn_started":
      return "Codex turn started on the existing task thread.";
    case "codex_turn_completed":
      return "Codex completed a turn; Claude should review the diff.";
    case "approval_requested":
      return `Codex requested ${String(payload.kind ?? "an")} approval.`;
    case "approval_resolved":
      return `Approval was ${String(payload.decision ?? "resolved")}.`;
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
  if (eventType === "context_near_limit") {
    return pick(payload, ["totalTokens", "limit", "contextPercent", "limitSource"]);
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

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) {
      picked[key] = source[key];
    }
  }
  return picked;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
