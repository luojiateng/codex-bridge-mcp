import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { nowIso } from "../shared/id.js";
import { fromJson, toJson } from "../shared/json.js";

export type RuntimeStatus =
  | "INIT"
  | "STARTING"
  | "RUNNING"
  | "DISCONNECTED"
  | "RECONNECTING"
  | "DEAD"
  | "RECREATED";

export interface RuntimeHostRecord {
  id: string;
  projectRoot: string;
  port: number;
  endpoint: string;
  pid: number | null;
  windowTitle: string | null;
  status: RuntimeStatus;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  projectRoot: string;
  runtimeHostId: string;
  codexThreadId: string;
  codexThreadName: string | null;
  status: string;
  requirements: unknown;
  acceptanceCriteria: unknown[];
  tokenBudget: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnRecord {
  id: string;
  taskId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  status: string;
  instruction: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  seq: number;
  taskId: string;
  runtimeHostId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  eventType: string;
  payload: unknown;
  claudeDelivered: boolean;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  runtimeHostId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  codexRequestId: string | number;
  kind: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  riskSummary: string | null;
  payload: unknown;
  decision: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ContextUsageRecord {
  taskId: string;
  runtimeHostId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  totalTokens: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  lastTotalTokens: number | null;
  modelContextWindow: number | null;
  contextPercent: number | null;
  limitSource: string | null;
  nearLimitEmitted: boolean;
  updatedAt: string;
}

export interface TaskCommandRecord {
  id: string;
  taskId: string;
  instruction: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface QueueSnapshot {
  queued: number;
  running: number;
  finished: number;
  failed: number;
  interrupted: number;
  nextQueuedAt: string | null;
  lastInterruptedAt: string | null;
}

export interface RuntimeDependentsInterrupted {
  tasks: TaskRecord[];
  turns: TurnRecord[];
  commands: TaskCommandRecord[];
  approvals: ApprovalRecord[];
}

type RuntimeHostRow = {
  id: string;
  project_root: string;
  port: number;
  endpoint: string;
  pid: number | null;
  window_title: string | null;
  status: RuntimeStatus;
  started_at: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  title: string;
  project_root: string;
  runtime_host_id: string;
  codex_thread_id: string;
  codex_thread_name: string | null;
  status: string;
  requirements_json: string | null;
  acceptance_json: string | null;
  token_budget: number | null;
  created_at: string;
  updated_at: string;
};

type TurnRow = {
  id: string;
  task_id: string;
  codex_thread_id: string;
  codex_turn_id: string | null;
  status: string;
  instruction: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  seq: number;
  task_id: string;
  runtime_host_id: string;
  codex_thread_id: string;
  codex_turn_id: string | null;
  event_type: string;
  payload_json: string;
  claude_delivered: number;
  created_at: string;
};

type ApprovalRow = {
  id: string;
  task_id: string;
  runtime_host_id: string;
  codex_thread_id: string;
  codex_turn_id: string | null;
  codex_request_id: string;
  kind: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  risk_summary: string | null;
  payload_json: string | null;
  decision: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  created_at: string;
  resolved_at: string | null;
};

type ContextUsageRow = {
  task_id: string;
  runtime_host_id: string;
  codex_thread_id: string;
  codex_turn_id: string | null;
  total_tokens: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  last_total_tokens: number | null;
  model_context_window: number | null;
  context_percent: number | null;
  limit_source: string | null;
  near_limit_emitted: number;
  updated_at: string;
};

type TaskCommandRow = {
  id: string;
  task_id: string;
  instruction: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  saveRuntime(runtime: RuntimeHostRecord): void {
    this.db
      .prepare(
        `
        insert into runtime_host (
          id, project_root, port, endpoint, pid, window_title, status,
          started_at, last_heartbeat_at, created_at, updated_at
        ) values (
          @id, @projectRoot, @port, @endpoint, @pid, @windowTitle, @status,
          @startedAt, @lastHeartbeatAt, @createdAt, @updatedAt
        )
        on conflict(id) do update set
          project_root = excluded.project_root,
          port = excluded.port,
          endpoint = excluded.endpoint,
          pid = excluded.pid,
          window_title = excluded.window_title,
          status = excluded.status,
          started_at = excluded.started_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          updated_at = excluded.updated_at
        `,
      )
      .run(runtime);
  }

  findRuntimeByProjectRoot(projectRoot: string): RuntimeHostRecord | null {
    const row = this.db
      .prepare("select * from runtime_host where project_root = ?")
      .get(projectRoot) as RuntimeHostRow | undefined;
    return row ? runtimeFromRow(row) : null;
  }

  getRuntime(id: string): RuntimeHostRecord | null {
    const row = this.db.prepare("select * from runtime_host where id = ?").get(id) as
      | RuntimeHostRow
      | undefined;
    return row ? runtimeFromRow(row) : null;
  }

  listRuntimes(): RuntimeHostRecord[] {
    const rows = this.db
      .prepare("select * from runtime_host order by created_at asc")
      .all() as RuntimeHostRow[];
    return rows.map(runtimeFromRow);
  }

  markRuntimeStatus(id: string, status: RuntimeStatus): void {
    this.db
      .prepare("update runtime_host set status = ?, updated_at = ? where id = ?")
      .run(status, nowIso(), id);
  }

  markRuntimeHeartbeat(id: string): void {
    const now = nowIso();
    this.db
      .prepare(
        "update runtime_host set status = 'RUNNING', last_heartbeat_at = ?, updated_at = ? where id = ?",
      )
      .run(now, now, id);
  }

  saveTask(task: TaskRecord): void {
    this.db
      .prepare(
        `
        insert into task (
          id, title, project_root, runtime_host_id, codex_thread_id,
          codex_thread_name, status, requirements_json, acceptance_json,
          token_budget, created_at, updated_at
        ) values (
          @id, @title, @projectRoot, @runtimeHostId, @codexThreadId,
          @codexThreadName, @status, @requirementsJson, @acceptanceJson,
          @tokenBudget, @createdAt, @updatedAt
        )
        on conflict(id) do update set
          title = excluded.title,
          project_root = excluded.project_root,
          runtime_host_id = excluded.runtime_host_id,
          codex_thread_id = excluded.codex_thread_id,
          codex_thread_name = excluded.codex_thread_name,
          status = excluded.status,
          requirements_json = excluded.requirements_json,
          acceptance_json = excluded.acceptance_json,
          token_budget = excluded.token_budget,
          updated_at = excluded.updated_at
        `,
      )
      .run({
        ...task,
        requirementsJson: toJson(task.requirements),
        acceptanceJson: toJson(task.acceptanceCriteria),
      });
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare("select * from task where id = ?").get(taskId) as
      | TaskRow
      | undefined;
    return row ? taskFromRow(row) : null;
  }

  getTaskByThread(runtimeHostId: string, codexThreadId: string): TaskRecord | null {
    const row = this.db
      .prepare("select * from task where runtime_host_id = ? and codex_thread_id = ?")
      .get(runtimeHostId, codexThreadId) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  updateTaskStatus(taskId: string, status: string): void {
    this.db
      .prepare("update task set status = ?, updated_at = ? where id = ?")
      .run(status, nowIso(), taskId);
  }

  listOpenTasksForRuntime(runtimeHostId: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        "select * from task where runtime_host_id = ? and status not in ('completed', 'cancelled')",
      )
      .all(runtimeHostId) as TaskRow[];
    return rows.map(taskFromRow);
  }

  listTasks(input: { projectRoot?: string; status?: string; limit: number }): TaskRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.projectRoot) {
      conditions.push("project_root = ?");
      params.push(input.projectRoot);
    }
    if (input.status) {
      conditions.push("status = ?");
      params.push(input.status);
    }
    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from task ${where} order by updated_at desc limit ?`)
      .all(...params, input.limit) as TaskRow[];
    return rows.map(taskFromRow);
  }

  saveTurn(turn: TurnRecord): void {
    this.db
      .prepare(
        `
        insert into turn (
          id, task_id, codex_thread_id, codex_turn_id, status,
          instruction, created_at, updated_at
        ) values (
          @id, @taskId, @codexThreadId, @codexTurnId, @status,
          @instruction, @createdAt, @updatedAt
        )
        on conflict(id) do update set
          codex_turn_id = excluded.codex_turn_id,
          status = excluded.status,
          instruction = excluded.instruction,
          updated_at = excluded.updated_at
        `,
      )
      .run(turn);
  }

  updateTurnByCodexTurnId(codexTurnId: string, status: string): void {
    this.db
      .prepare("update turn set status = ?, updated_at = ? where codex_turn_id = ?")
      .run(status, nowIso(), codexTurnId);
  }

  getLatestTurn(taskId: string): TurnRecord | null {
    const row = this.db
      .prepare("select * from turn where task_id = ? order by created_at desc limit 1")
      .get(taskId) as TurnRow | undefined;
    return row ? turnFromRow(row) : null;
  }

  getTurnByCodexTurnId(codexTurnId: string): TurnRecord | null {
    const row = this.db
      .prepare("select * from turn where codex_turn_id = ?")
      .get(codexTurnId) as TurnRow | undefined;
    return row ? turnFromRow(row) : null;
  }

  appendEvent(input: Omit<EventRecord, "seq" | "createdAt" | "claudeDelivered">): EventRecord {
    const createdAt = nowIso();
    const result = this.db
      .prepare(
        `
        insert into event (
          task_id, runtime_host_id, codex_thread_id, codex_turn_id,
          event_type, payload_json, claude_delivered, created_at
        ) values (?, ?, ?, ?, ?, ?, 0, ?)
        `,
      )
      .run(
        input.taskId,
        input.runtimeHostId,
        input.codexThreadId,
        input.codexTurnId,
        input.eventType,
        toJson(input.payload),
        createdAt,
      );

    return {
      ...input,
      seq: Number(result.lastInsertRowid),
      claudeDelivered: false,
      createdAt,
    };
  }

  listUndeliveredEvents(taskId: string, limit: number): EventRecord[] {
    const rows = this.db
      .prepare(
        `
        select * from event
        where task_id = ? and claude_delivered = 0
        order by seq asc
        limit ?
        `,
      )
      .all(taskId, limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  listEvents(taskId: string, afterSeq: number | null, limit: number): EventRecord[] {
    const rows = this.db
      .prepare(
        `
        select * from event
        where task_id = ? and seq > coalesce(?, 0)
        order by seq asc
        limit ?
        `,
      )
      .all(taskId, afterSeq, limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  markEventsDelivered(seqValues: number[]): void {
    if (seqValues.length === 0) {
      return;
    }
    const stmt = this.db.prepare("update event set claude_delivered = 1 where seq = ?");
    const tx = this.db.transaction((seqs: number[]) => {
      for (const seq of seqs) {
        stmt.run(seq);
      }
    });
    tx(seqValues);
  }

  saveApproval(approval: ApprovalRecord): void {
    this.db
      .prepare(
        `
        insert into approval (
          id, task_id, runtime_host_id, codex_thread_id, codex_turn_id,
          codex_request_id, kind, command, cwd, reason, risk_summary, payload_json,
          decision, decided_by, decision_reason, created_at, resolved_at
        ) values (
          @id, @taskId, @runtimeHostId, @codexThreadId, @codexTurnId,
          @codexRequestId, @kind, @command, @cwd, @reason, @riskSummary, @payloadJson,
          @decision, @decidedBy, @decisionReason, @createdAt, @resolvedAt
        )
        on conflict(id) do update set
          decision = excluded.decision,
          decided_by = excluded.decided_by,
          decision_reason = excluded.decision_reason,
          resolved_at = excluded.resolved_at
        `,
      )
      .run({
        ...approval,
        codexRequestId: JSON.stringify(approval.codexRequestId),
        payloadJson: toJson(approval.payload),
      });
  }

  getApproval(approvalId: string): ApprovalRecord | null {
    const row = this.db.prepare("select * from approval where id = ?").get(approvalId) as
      | ApprovalRow
      | undefined;
    return row ? approvalFromRow(row) : null;
  }

  getPendingApproval(taskId: string): ApprovalRecord | null {
    const row = this.db
      .prepare(
        `
        select * from approval
        where task_id = ? and decision is null
        order by created_at asc
        limit 1
        `,
      )
      .get(taskId) as ApprovalRow | undefined;
    return row ? approvalFromRow(row) : null;
  }

  resolveApproval(approvalId: string, decision: string, decidedBy: string, reason: string): void {
    this.db
      .prepare(
        `
        update approval
        set decision = ?, decided_by = ?, decision_reason = ?, resolved_at = ?
        where id = ?
        `,
      )
      .run(decision, decidedBy, reason, nowIso(), approvalId);
  }

  saveContextUsage(usage: ContextUsageRecord): void {
    this.db
      .prepare(
        `
        insert into context_usage (
          task_id, runtime_host_id, codex_thread_id, codex_turn_id,
          total_tokens, input_tokens, cached_input_tokens, output_tokens,
          reasoning_output_tokens, last_total_tokens, model_context_window,
          context_percent, limit_source, near_limit_emitted, updated_at
        ) values (
          @taskId, @runtimeHostId, @codexThreadId, @codexTurnId,
          @totalTokens, @inputTokens, @cachedInputTokens, @outputTokens,
          @reasoningOutputTokens, @lastTotalTokens, @modelContextWindow,
          @contextPercent, @limitSource, @nearLimitEmittedValue, @updatedAt
        )
        on conflict(task_id) do update set
          runtime_host_id = excluded.runtime_host_id,
          codex_thread_id = excluded.codex_thread_id,
          codex_turn_id = excluded.codex_turn_id,
          total_tokens = excluded.total_tokens,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          last_total_tokens = excluded.last_total_tokens,
          model_context_window = excluded.model_context_window,
          context_percent = excluded.context_percent,
          limit_source = excluded.limit_source,
          near_limit_emitted = excluded.near_limit_emitted,
          updated_at = excluded.updated_at
        `,
      )
      .run({
        ...usage,
        nearLimitEmittedValue: usage.nearLimitEmitted ? 1 : 0,
      });
  }

  getContextUsage(taskId: string): ContextUsageRecord | null {
    const row = this.db
      .prepare("select * from context_usage where task_id = ?")
      .get(taskId) as ContextUsageRow | undefined;
    return row ? contextUsageFromRow(row) : null;
  }

  markContextNearLimitEmitted(taskId: string): void {
    this.db
      .prepare(
        "update context_usage set near_limit_emitted = 1, updated_at = ? where task_id = ?",
      )
      .run(nowIso(), taskId);
  }

  enqueueCommand(id: string, taskId: string, instruction: string): void {
    this.db
      .prepare(
        `
        insert into task_command_queue (id, task_id, instruction, status, created_at)
        values (?, ?, ?, 'queued', ?)
        `,
      )
      .run(id, taskId, instruction, nowIso());
  }

  markCommandStarted(id: string): void {
    this.db
      .prepare("update task_command_queue set status = 'running', started_at = ? where id = ?")
      .run(nowIso(), id);
  }

  markCommandFinished(id: string): void {
    this.db
      .prepare("update task_command_queue set status = 'finished', finished_at = ? where id = ?")
      .run(nowIso(), id);
  }

  markCommandFailed(id: string): void {
    this.db
      .prepare("update task_command_queue set status = 'failed', finished_at = ? where id = ?")
      .run(nowIso(), id);
  }

  markRuntimeDependentsInterrupted(runtimeHostId: string): RuntimeDependentsInterrupted {
    const tx = this.db.transaction((): RuntimeDependentsInterrupted => {
      const taskRows = this.db
        .prepare("select * from task where runtime_host_id = ?")
        .all(runtimeHostId) as TaskRow[];
      const turnRows = this.db
        .prepare(
          `
          select turn.* from turn
          inner join task on task.id = turn.task_id
          where task.runtime_host_id = ? and turn.status = 'running'
          order by turn.created_at asc
          `,
        )
        .all(runtimeHostId) as TurnRow[];
      const commandRows = this.db
        .prepare(
          `
          select task_command_queue.* from task_command_queue
          inner join task on task.id = task_command_queue.task_id
          where task.runtime_host_id = ? and task_command_queue.status = 'running'
          order by task_command_queue.started_at asc
          `,
        )
        .all(runtimeHostId) as TaskCommandRow[];
      const approvalRows = this.db
        .prepare(
          `
          select approval.* from approval
          inner join task on task.id = approval.task_id
          where task.runtime_host_id = ? and approval.decision is null
          order by approval.created_at asc
          `,
        )
        .all(runtimeHostId) as ApprovalRow[];

      if (turnRows.length === 0 && commandRows.length === 0 && approvalRows.length === 0) {
        return { tasks: [], turns: [], commands: [], approvals: [] };
      }

      const now = nowIso();
      const approvalDecisionReason =
        "Bridge automatically denied this pending approval because its Runtime Host was unreachable and treated as DEAD.";
      const affectedTaskIds = new Set([
        ...turnRows.map((row) => row.task_id),
        ...commandRows.map((row) => row.task_id),
        ...approvalRows.map((row) => row.task_id),
      ]);
      const taskIdPlaceholders = [...affectedTaskIds].map(() => "?").join(", ");
      this.db
        .prepare(
          `update task set status = 'interrupted', updated_at = ? where id in (${taskIdPlaceholders})`,
        )
        .run(now, ...affectedTaskIds);
      this.db
        .prepare(
          `
          update turn set status = 'interrupted', updated_at = ?
          where status = 'running'
            and task_id in (select id from task where runtime_host_id = ?)
          `,
        )
        .run(now, runtimeHostId);
      this.db
        .prepare(
          `
          update task_command_queue set status = 'interrupted', finished_at = ?
          where status = 'running'
            and task_id in (select id from task where runtime_host_id = ?)
          `,
        )
        .run(now, runtimeHostId);
      this.db
        .prepare(
          `
          update approval
          set decision = 'auto_denied', decided_by = 'bridge', decision_reason = ?, resolved_at = ?
          where decision is null
            and task_id in (select id from task where runtime_host_id = ?)
          `,
        )
        .run(approvalDecisionReason, now, runtimeHostId);

      return {
        tasks: taskRows
          .filter((row) => affectedTaskIds.has(row.id))
          .map((row) => taskFromRow({ ...row, status: "interrupted", updated_at: now })),
        turns: turnRows.map((row) =>
          turnFromRow({ ...row, status: "interrupted", updated_at: now }),
        ),
        commands: commandRows.map((row) =>
          taskCommandFromRow({ ...row, status: "interrupted", finished_at: now }),
        ),
        approvals: approvalRows.map((row) =>
          approvalFromRow({
            ...row,
            decision: "auto_denied",
            decided_by: "bridge",
            decision_reason: approvalDecisionReason,
            resolved_at: now,
          }),
        ),
      };
    });
    return tx();
  }

  getQueueSnapshot(taskId: string): QueueSnapshot {
    const rows = this.db
      .prepare(
        `
        select status, count(*) as count, min(created_at) as first_created_at, max(finished_at) as last_finished_at
        from task_command_queue
        where task_id = ?
        group by status
        `,
      )
      .all(taskId) as Array<{
      status: string;
      count: number;
      first_created_at: string | null;
      last_finished_at: string | null;
    }>;
    const snapshot: QueueSnapshot = {
      queued: 0,
      running: 0,
      finished: 0,
      failed: 0,
      interrupted: 0,
      nextQueuedAt: null,
      lastInterruptedAt: null,
    };
    for (const row of rows) {
      if (row.status === "queued") {
        snapshot.queued = row.count;
        snapshot.nextQueuedAt = row.first_created_at;
      } else if (row.status === "running") {
        snapshot.running = row.count;
      } else if (row.status === "finished") {
        snapshot.finished = row.count;
      } else if (row.status === "failed") {
        snapshot.failed = row.count;
      } else if (row.status === "interrupted") {
        snapshot.interrupted = row.count;
        snapshot.lastInterruptedAt = row.last_finished_at;
      }
    }
    return snapshot;
  }

  listCommandsByStatus(taskId: string, statuses: string[], limit: number): TaskCommandRecord[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
        select * from task_command_queue
        where task_id = ? and status in (${placeholders})
        order by created_at asc
        limit ?
        `,
      )
      .all(taskId, ...statuses, limit) as TaskCommandRow[];
    return rows.map(taskCommandFromRow);
  }

  private initSchema(): void {
    const schemaPath = fileURLToPath(new URL("schema.sql", import.meta.url));
    this.db.exec(fs.readFileSync(schemaPath, "utf8"));
    this.ensureColumn("approval", "payload_json", "text");
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`alter table ${table} add column ${column} ${type}`);
    }
  }
}

function runtimeFromRow(row: RuntimeHostRow): RuntimeHostRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    port: row.port,
    endpoint: row.endpoint,
    pid: row.pid,
    windowTitle: row.window_title,
    status: row.status,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    projectRoot: row.project_root,
    runtimeHostId: row.runtime_host_id,
    codexThreadId: row.codex_thread_id,
    codexThreadName: row.codex_thread_name,
    status: row.status,
    requirements: fromJson(row.requirements_json, null),
    acceptanceCriteria: fromJson<unknown[]>(row.acceptance_json, []),
    tokenBudget: row.token_budget,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function turnFromRow(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    status: row.status,
    instruction: row.instruction,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): EventRecord {
  return {
    seq: row.seq,
    taskId: row.task_id,
    runtimeHostId: row.runtime_host_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    eventType: row.event_type,
    payload: fromJson(row.payload_json, null),
    claudeDelivered: row.claude_delivered === 1,
    createdAt: row.created_at,
  };
}

function approvalFromRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    runtimeHostId: row.runtime_host_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    codexRequestId: JSON.parse(row.codex_request_id) as string | number,
    kind: row.kind,
    command: row.command,
    cwd: row.cwd,
    reason: row.reason,
    riskSummary: row.risk_summary,
    payload: fromJson(row.payload_json, null),
    decision: row.decision,
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function contextUsageFromRow(row: ContextUsageRow): ContextUsageRecord {
  return {
    taskId: row.task_id,
    runtimeHostId: row.runtime_host_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    lastTotalTokens: row.last_total_tokens,
    modelContextWindow: row.model_context_window,
    contextPercent: row.context_percent,
    limitSource: row.limit_source,
    nearLimitEmitted: row.near_limit_emitted === 1,
    updatedAt: row.updated_at,
  };
}

function taskCommandFromRow(row: TaskCommandRow): TaskCommandRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    instruction: row.instruction,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
