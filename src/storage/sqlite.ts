import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createId, nowIso } from "../shared/id.js";
import { fromJson, toJson } from "../shared/json.js";
import { canonicalizeProjectRoot } from "../shared/projectRoot.js";

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

export type ProjectSessionStatus = "CREATING" | "ACTIVE" | "RECOVERING" | "FAILED";

export interface ProjectSessionRecord {
  id: string;
  projectKey: string;
  projectRoot: string;
  generation: number;
  runtimeHostId: string | null;
  activeTaskId: string | null;
  codexThreadId: string | null;
  status: ProjectSessionStatus;
  claimToken: string | null;
  claimExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSessionClaimOutcome = "create" | "reuse" | "wait";

export interface ProjectSessionClaim {
  outcome: ProjectSessionClaimOutcome;
  session: ProjectSessionRecord;
}

export type TuiInstanceStatus = "LAUNCHING" | "RUNNING" | "STALE" | "FAILED";

export interface TuiInstanceRecord {
  sessionId: string;
  generation: number;
  runtimeEndpoint: string;
  codexThreadId: string;
  pid: number | null;
  processStartedAt: string | null;
  status: TuiInstanceStatus;
  claimToken: string | null;
  claimExpiresAt: string | null;
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
  attentionRevision: number;
  attentionAckRevision: number;
  attentionKind: string | null;
  attentionPayload: unknown;
  result: unknown;
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

export interface OrphanedRuntimeApprovals {
  turns: TurnRecord[];
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

type ProjectSessionRow = {
  id: string;
  project_key: string;
  project_root: string;
  generation: number;
  runtime_host_id: string | null;
  active_task_id: string | null;
  codex_thread_id: string | null;
  status: ProjectSessionStatus;
  claim_token: string | null;
  claim_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type TuiInstanceRow = {
  session_id: string;
  generation: number;
  runtime_endpoint: string;
  codex_thread_id: string;
  pid: number | null;
  process_started_at: string | null;
  status: TuiInstanceStatus;
  claim_token: string | null;
  claim_expires_at: string | null;
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
  attention_revision: number;
  attention_ack_revision: number;
  attention_kind: string | null;
  attention_payload_json: string | null;
  result_json: string | null;
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
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.initSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  saveRuntime(runtime: RuntimeHostRecord): void {
    const canonicalProjectRoot = canonicalizeProjectRoot(runtime.projectRoot).projectRoot;
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
      .run({ ...runtime, projectRoot: canonicalProjectRoot });
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

  getProjectSessionByKey(projectKey: string): ProjectSessionRecord | null {
    const row = this.db
      .prepare("select * from project_session where project_key = ?")
      .get(projectKey) as ProjectSessionRow | undefined;
    return row ? projectSessionFromRow(row) : null;
  }

  getProjectSessionById(sessionId: string): ProjectSessionRecord | null {
    const row = this.db
      .prepare("select * from project_session where id = ?")
      .get(sessionId) as ProjectSessionRow | undefined;
    return row ? projectSessionFromRow(row) : null;
  }

  claimProjectSession(input: {
    projectKey: string;
    projectRoot: string;
    mode: "reuse" | "new";
    claimToken: string;
    claimExpiresAt: string;
    joinGeneration?: number;
  }): ProjectSessionClaim {
    const tx = this.db.transaction((): ProjectSessionClaim => {
      const now = nowIso();
      const row = this.db
        .prepare("select * from project_session where project_key = ?")
        .get(input.projectKey) as ProjectSessionRow | undefined;
      if (!row) {
        const session: ProjectSessionRecord = {
          id: createId("session"),
          projectKey: input.projectKey,
          projectRoot: input.projectRoot,
          generation: 1,
          runtimeHostId: null,
          activeTaskId: null,
          codexThreadId: null,
          status: "CREATING",
          claimToken: input.claimToken,
          claimExpiresAt: input.claimExpiresAt,
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare(
            `
            insert into project_session (
              id, project_key, project_root, generation, runtime_host_id,
              active_task_id, codex_thread_id, status, claim_token,
              claim_expires_at, created_at, updated_at
            ) values (
              @id, @projectKey, @projectRoot, @generation, @runtimeHostId,
              @activeTaskId, @codexThreadId, @status, @claimToken,
              @claimExpiresAt, @createdAt, @updatedAt
            )
            `,
          )
          .run(session);
        return { outcome: "create", session };
      }

      const existing = projectSessionFromRow(row);
      if (existing.status === "CREATING") {
        const claimAlive = Date.parse(existing.claimExpiresAt ?? "") > Date.now();
        if (claimAlive && existing.claimToken !== input.claimToken) {
          return { outcome: "wait", session: existing };
        }
        const generation = input.joinGeneration ?? existing.generation;
        this.db
          .prepare(
            `
            update project_session
            set project_root = ?, generation = ?, status = 'CREATING',
                claim_token = ?, claim_expires_at = ?, updated_at = ?
            where id = ?
            `,
          )
          .run(
            input.projectRoot,
            generation,
            input.claimToken,
            input.claimExpiresAt,
            now,
            existing.id,
          );
        return {
          outcome: "create",
          session: {
            ...existing,
            projectRoot: input.projectRoot,
            generation,
            status: "CREATING",
            claimToken: input.claimToken,
            claimExpiresAt: input.claimExpiresAt,
            updatedAt: now,
          },
        };
      }

      if (
        input.joinGeneration !== undefined &&
        existing.generation === input.joinGeneration &&
        existing.status === "ACTIVE"
      ) {
        return { outcome: "reuse", session: existing };
      }
      if (input.mode === "reuse" && existing.status === "ACTIVE") {
        return { outcome: "reuse", session: existing };
      }
      if (
        input.mode === "reuse" &&
        existing.status === "RECOVERING" &&
        existing.activeTaskId &&
        existing.codexThreadId
      ) {
        return { outcome: "reuse", session: existing };
      }

      if (input.mode === "new" && existing.activeTaskId) {
        const activeTurn = this.db
          .prepare("select status from turn where task_id = ? order by created_at desc limit 1")
          .get(existing.activeTaskId) as { status: string } | undefined;
        if (activeTurn && ["running", "awaiting_approval"].includes(activeTurn.status)) {
          throw new Error(
            `Cannot open a new project session while task ${existing.activeTaskId} has an active turn.`,
          );
        }
      }

      const generation =
        input.joinGeneration ?? (input.mode === "new" ? existing.generation + 1 : existing.generation);
      this.db
        .prepare(
          `
          update project_session
          set project_root = ?, generation = ?, status = 'CREATING',
              claim_token = ?, claim_expires_at = ?, updated_at = ?
          where id = ?
          `,
        )
        .run(
          input.projectRoot,
          generation,
          input.claimToken,
          input.claimExpiresAt,
          now,
          existing.id,
        );
      return {
        outcome: "create",
        session: {
          ...existing,
          projectRoot: input.projectRoot,
          generation,
          status: "CREATING",
          claimToken: input.claimToken,
          claimExpiresAt: input.claimExpiresAt,
          updatedAt: now,
        },
      };
    });
    return tx();
  }

  completeProjectSessionClaim(input: {
    sessionId: string;
    claimToken: string;
    task: TaskRecord;
  }): ProjectSessionRecord {
    const tx = this.db.transaction((): ProjectSessionRecord => {
      const now = nowIso();
      const claim = this.db
        .prepare(
          "select id from project_session where id = ? and status = 'CREATING' and claim_token = ?",
        )
        .get(input.sessionId, input.claimToken);
      if (!claim) {
        throw new Error(`Project session claim was lost before completion: ${input.sessionId}`);
      }
      this.saveTask(input.task);
      this.db
        .prepare(
          `
          update project_session
          set runtime_host_id = ?, active_task_id = ?, codex_thread_id = ?,
              status = 'ACTIVE', claim_token = null, claim_expires_at = null, updated_at = ?
          where id = ?
          `,
        )
        .run(
          input.task.runtimeHostId,
          input.task.id,
          input.task.codexThreadId,
          now,
          input.sessionId,
        );
      const session = this.getProjectSessionById(input.sessionId);
      if (!session) {
        throw new Error(`Project session disappeared after completion: ${input.sessionId}`);
      }
      return session;
    });
    return tx();
  }

  failProjectSessionClaim(sessionId: string, claimToken: string): void {
    this.db
      .prepare(
        `
        update project_session
        set status = case when active_task_id is null then 'FAILED' else 'ACTIVE' end,
            claim_token = null, claim_expires_at = null, updated_at = ?
        where id = ? and status = 'CREATING' and claim_token = ?
        `,
      )
      .run(nowIso(), sessionId, claimToken);
  }

  updateProjectSessionRuntime(sessionId: string, runtimeHostId: string): void {
    this.db
      .prepare(
        `
        update project_session
        set runtime_host_id = ?, status = 'ACTIVE', updated_at = ?
        where id = ?
        `,
      )
      .run(runtimeHostId, nowIso(), sessionId);
  }

  activateProjectSessionForTask(task: TaskRecord): ProjectSessionRecord {
    const canonical = canonicalizeProjectRoot(task.projectRoot);
    const tx = this.db.transaction((): ProjectSessionRecord => {
      const existing = this.getProjectSessionByKey(canonical.projectKey);
      const now = nowIso();
      if (!existing) {
        const session: ProjectSessionRecord = {
          id: createId("session"),
          projectKey: canonical.projectKey,
          projectRoot: canonical.projectRoot,
          generation: 1,
          runtimeHostId: task.runtimeHostId,
          activeTaskId: task.id,
          codexThreadId: task.codexThreadId,
          status: "ACTIVE",
          claimToken: null,
          claimExpiresAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare(
            `
            insert into project_session (
              id, project_key, project_root, generation, runtime_host_id,
              active_task_id, codex_thread_id, status, claim_token,
              claim_expires_at, created_at, updated_at
            ) values (
              @id, @projectKey, @projectRoot, @generation, @runtimeHostId,
              @activeTaskId, @codexThreadId, @status, @claimToken,
              @claimExpiresAt, @createdAt, @updatedAt
            )
            `,
          )
          .run(session);
        return session;
      }
      const generation =
        existing.activeTaskId === task.id ? existing.generation : existing.generation + 1;
      this.db
        .prepare(
          `
          update project_session
          set project_root = ?, generation = ?, runtime_host_id = ?,
              active_task_id = ?, codex_thread_id = ?, status = 'ACTIVE',
              claim_token = null, claim_expires_at = null, updated_at = ?
          where id = ?
          `,
        )
        .run(
          canonical.projectRoot,
          generation,
          task.runtimeHostId,
          task.id,
          task.codexThreadId,
          now,
          existing.id,
        );
      return {
        ...existing,
        projectRoot: canonical.projectRoot,
        generation,
        runtimeHostId: task.runtimeHostId,
        activeTaskId: task.id,
        codexThreadId: task.codexThreadId,
        status: "ACTIVE",
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: now,
      };
    });
    return tx();
  }

  markProjectSessionsRecovering(runtimeHostId: string): void {
    this.db
      .prepare(
        `
        update project_session
        set status = 'RECOVERING', generation = generation + 1, updated_at = ?
        where runtime_host_id = ? and status = 'ACTIVE'
        `,
      )
      .run(nowIso(), runtimeHostId);
  }

  getTuiInstance(sessionId: string): TuiInstanceRecord | null {
    const row = this.db
      .prepare("select * from tui_instance where session_id = ?")
      .get(sessionId) as TuiInstanceRow | undefined;
    return row ? tuiInstanceFromRow(row) : null;
  }

  claimTuiLaunch(input: {
    sessionId: string;
    generation: number;
    runtimeEndpoint: string;
    codexThreadId: string;
    claimToken: string;
    claimExpiresAt: string;
  }): { outcome: "launch" | "wait"; instance: TuiInstanceRecord } {
    const tx = this.db.transaction((): {
      outcome: "launch" | "wait";
      instance: TuiInstanceRecord;
    } => {
      const existing = this.getTuiInstance(input.sessionId);
      const now = nowIso();
      if (
        existing?.status === "LAUNCHING" &&
        Date.parse(existing.claimExpiresAt ?? "") > Date.now() &&
        existing.claimToken !== input.claimToken
      ) {
        return { outcome: "wait", instance: existing };
      }
      const instance: TuiInstanceRecord = {
        sessionId: input.sessionId,
        generation: input.generation,
        runtimeEndpoint: input.runtimeEndpoint,
        codexThreadId: input.codexThreadId,
        pid: null,
        processStartedAt: null,
        status: "LAUNCHING",
        claimToken: input.claimToken,
        claimExpiresAt: input.claimExpiresAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.db
        .prepare(
          `
          insert into tui_instance (
            session_id, generation, runtime_endpoint, codex_thread_id, pid,
            process_started_at, status, claim_token, claim_expires_at,
            created_at, updated_at
          ) values (
            @sessionId, @generation, @runtimeEndpoint, @codexThreadId, @pid,
            @processStartedAt, @status, @claimToken, @claimExpiresAt,
            @createdAt, @updatedAt
          )
          on conflict(session_id) do update set
            generation = excluded.generation,
            runtime_endpoint = excluded.runtime_endpoint,
            codex_thread_id = excluded.codex_thread_id,
            pid = excluded.pid,
            process_started_at = excluded.process_started_at,
            status = excluded.status,
            claim_token = excluded.claim_token,
            claim_expires_at = excluded.claim_expires_at,
            updated_at = excluded.updated_at
          `,
        )
        .run(instance);
      return { outcome: "launch", instance };
    });
    return tx();
  }

  completeTuiLaunch(input: {
    sessionId: string;
    claimToken: string;
    pid: number | null;
    processStartedAt: string;
  }): TuiInstanceRecord {
    const result = this.db
      .prepare(
        `
        update tui_instance
        set pid = ?, process_started_at = ?, status = 'RUNNING',
            claim_token = null, claim_expires_at = null, updated_at = ?
        where session_id = ? and status = 'LAUNCHING' and claim_token = ?
        `,
      )
      .run(
        input.pid,
        input.processStartedAt,
        nowIso(),
        input.sessionId,
        input.claimToken,
      );
    if (result.changes !== 1) {
      throw new Error(`TUI launch claim was lost before completion: ${input.sessionId}`);
    }
    const instance = this.getTuiInstance(input.sessionId);
    if (!instance) {
      throw new Error(`TUI instance disappeared after launch: ${input.sessionId}`);
    }
    return instance;
  }

  failTuiLaunch(sessionId: string, claimToken: string): void {
    this.db
      .prepare(
        `
        update tui_instance
        set status = 'FAILED', claim_token = null, claim_expires_at = null, updated_at = ?
        where session_id = ? and status = 'LAUNCHING' and claim_token = ?
        `,
      )
      .run(nowIso(), sessionId, claimToken);
  }

  markTuiInstancesStale(runtimeEndpoint: string): TuiInstanceRecord[] {
    const tx = this.db.transaction((): TuiInstanceRecord[] => {
      const rows = this.db
        .prepare("select * from tui_instance where runtime_endpoint = ? and status = 'RUNNING'")
        .all(runtimeEndpoint) as TuiInstanceRow[];
      if (rows.length > 0) {
        this.db
          .prepare(
            `
            update tui_instance
            set status = 'STALE', updated_at = ?
            where runtime_endpoint = ? and status = 'RUNNING'
            `,
          )
          .run(nowIso(), runtimeEndpoint);
      }
      return rows.map(tuiInstanceFromRow);
    });
    return tx();
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
          instruction, attention_revision, attention_ack_revision, attention_kind,
          attention_payload_json, result_json, created_at, updated_at
        ) values (
          @id, @taskId, @codexThreadId, @codexTurnId, @status,
          @instruction, @attentionRevision, @attentionAckRevision, @attentionKind,
          @attentionPayloadJson, @resultJson, @createdAt, @updatedAt
        )
        on conflict(id) do update set
          codex_turn_id = excluded.codex_turn_id,
          status = excluded.status,
          instruction = excluded.instruction,
          attention_revision = excluded.attention_revision,
          attention_ack_revision = max(attention_ack_revision, excluded.attention_ack_revision),
          attention_kind = excluded.attention_kind,
          attention_payload_json = excluded.attention_payload_json,
          result_json = excluded.result_json,
          updated_at = excluded.updated_at
        `,
      )
      .run({
        ...turn,
        attentionRevision: turn.attentionRevision ?? 0,
        attentionAckRevision: turn.attentionAckRevision ?? 0,
        attentionKind: turn.attentionKind ?? null,
        attentionPayloadJson: toJson(turn.attentionPayload),
        resultJson: toJson(turn.result),
      });
  }

  updateTurnResult(codexTurnId: string, result: unknown): void {
    this.db
      .prepare("update turn set result_json = ?, updated_at = ? where codex_turn_id = ?")
      .run(toJson(result), nowIso(), codexTurnId);
  }

  getLatestPendingAttention(taskId: string): TurnRecord | null {
    const row = this.db
      .prepare(
        `
        select * from turn
        where id = (
          select id from turn
          where task_id = ?
          order by created_at desc, rowid desc
          limit 1
        )
          and codex_turn_id is not null
          and attention_kind is not null
          and attention_revision > attention_ack_revision
        `,
      )
      .get(taskId) as TurnRow | undefined;
    return row ? turnFromRow(row) : null;
  }

  acknowledgeTurnAttention(codexTurnId: string, revision: number): TurnRecord | null {
    this.db
      .prepare(
        `
        update turn
        set attention_ack_revision = min(
              attention_revision,
              max(attention_ack_revision, ?)
            ),
            updated_at = ?
        where codex_turn_id = ?
        `,
      )
      .run(Math.max(0, revision), nowIso(), codexTurnId);
    return this.getTurnByCodexTurnId(codexTurnId);
  }

  recordTurnAttention(input: {
    taskId: string;
    codexTurnId: string;
    turnStatus: string;
    taskStatus: string;
    attentionKind: string;
    attentionPayload: unknown;
    event?: Omit<EventRecord, "seq" | "createdAt" | "claudeDelivered">;
  }): { turn: TurnRecord | null; event: EventRecord | null } {
    const tx = this.db.transaction(() => {
      const now = nowIso();
      const updated = this.db
        .prepare(
          `
          update turn
          set status = ?, attention_revision = attention_revision + 1,
              attention_kind = ?, attention_payload_json = ?, updated_at = ?
          where task_id = ? and codex_turn_id = ?
            and status in ('running', 'awaiting_approval')
          `,
        )
        .run(
          input.turnStatus,
          input.attentionKind,
          toJson(input.attentionPayload),
          now,
          input.taskId,
          input.codexTurnId,
        );
      if (updated.changes === 0) {
        return {
          turn: this.getTurnByCodexTurnId(input.codexTurnId),
          event: null,
        };
      }
      this.db
        .prepare("update task set status = ?, updated_at = ? where id = ?")
        .run(input.taskStatus, now, input.taskId);
      return {
        turn: this.getTurnByCodexTurnId(input.codexTurnId),
        event: input.event ? this.appendEvent(input.event) : null,
      };
    });
    return tx();
  }

  recordApprovalAttention(
    approval: ApprovalRecord,
    eventInput: Omit<EventRecord, "seq" | "createdAt" | "claudeDelivered">,
  ): { approval: ApprovalRecord; event: EventRecord | null; turn: TurnRecord | null; created: boolean } {
    const tx = this.db.transaction(() => {
      let activeTurn = approval.codexTurnId
        ? this.getTurnByCodexTurnId(approval.codexTurnId)
        : this.getLatestTurn(approval.taskId);
      if (!activeTurn && approval.codexTurnId) {
        const now = nowIso();
        this.saveTurn({
          id: `turn_${approval.codexTurnId}`,
          taskId: approval.taskId,
          codexThreadId: approval.codexThreadId,
          codexTurnId: approval.codexTurnId,
          status: "running",
          instruction: null,
          attentionRevision: 0,
          attentionAckRevision: 0,
          attentionKind: null,
          attentionPayload: null,
          result: null,
          createdAt: now,
          updatedAt: now,
        });
        activeTurn = this.getTurnByCodexTurnId(approval.codexTurnId);
      }
      if (!activeTurn?.codexTurnId || !["running", "awaiting_approval"].includes(activeTurn.status)) {
        throw new Error(`Approval received without an active Codex turn: ${approval.taskId}`);
      }
      const effectiveApproval = {
        ...approval,
        codexTurnId: activeTurn.codexTurnId,
      };
      const existing = this.getApprovalByRequest(effectiveApproval);
      if (existing) {
        return {
          approval: existing,
          event: null,
          turn: existing.codexTurnId
            ? this.getTurnByCodexTurnId(existing.codexTurnId)
            : this.getLatestTurn(existing.taskId),
          created: false,
        };
      }

      this.saveApproval(effectiveApproval);
      const now = nowIso();
      this.db
        .prepare(
          `
          update turn
          set status = 'awaiting_approval',
              attention_revision = attention_revision + 1,
              attention_kind = 'approval', attention_payload_json = ?, updated_at = ?
          where task_id = ? and codex_turn_id = ? and status = 'running'
          `,
        )
        .run(toJson(eventInput.payload), now, approval.taskId, activeTurn.codexTurnId);
      this.db
        .prepare("update task set status = 'awaiting_approval', updated_at = ? where id = ?")
        .run(now, approval.taskId);
      const turn = this.getTurnByCodexTurnId(activeTurn.codexTurnId);
      const event = this.appendEvent(eventInput);
      return { approval: effectiveApproval, event, turn, created: true };
    });
    return tx();
  }

  resolveApprovalAndResumeTurn(
    approvalId: string,
    decision: string,
    decidedBy: string,
    reason: string,
    eventInput: Omit<EventRecord, "seq" | "createdAt" | "claudeDelivered">,
  ): { event: EventRecord; turn: TurnRecord | null } {
    const tx = this.db.transaction(() => {
      const approval = this.getApproval(approvalId);
      if (!approval) {
        throw new Error(`approvalId not found: ${approvalId}`);
      }
      const now = nowIso();
      const currentTurn = approval.codexTurnId
        ? this.getTurnByCodexTurnId(approval.codexTurnId)
        : null;
      this.db
        .prepare(
          `
          update approval
          set decision = ?, decided_by = ?, decision_reason = ?, resolved_at = ?
          where id = ? and decision is null
          `,
        )
        .run(decision, decidedBy, reason, now, approvalId);
      if (approval.codexTurnId && currentTurn?.status === "awaiting_approval") {
        this.db
          .prepare(
            `
            update turn
            set status = 'running', attention_kind = null,
                attention_payload_json = null, updated_at = ?
            where codex_turn_id = ? and status = 'awaiting_approval'
            `,
          )
          .run(now, approval.codexTurnId);
        this.db
          .prepare("update task set status = 'running', updated_at = ? where id = ?")
          .run(now, approval.taskId);
      }
      return {
        event: this.appendEvent(eventInput),
        turn: approval.codexTurnId ? this.getTurnByCodexTurnId(approval.codexTurnId) : null,
      };
    });
    return tx();
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

  private getApprovalByRequest(approval: ApprovalRecord): ApprovalRecord | null {
    const row = this.db
      .prepare(
        `
        select * from approval
        where task_id = ? and codex_request_id = ? and kind = ?
          and ((codex_turn_id = ?) or (codex_turn_id is null and ? is null))
        order by created_at asc
        limit 1
        `,
      )
      .get(
        approval.taskId,
        JSON.stringify(approval.codexRequestId),
        approval.kind,
        approval.codexTurnId,
        approval.codexTurnId,
      ) as ApprovalRow | undefined;
    return row ? approvalFromRow(row) : null;
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

  orphanPendingApprovalsForRuntime(
    runtimeHostId: string,
    reason: string,
  ): OrphanedRuntimeApprovals {
    const tx = this.db.transaction((): OrphanedRuntimeApprovals => {
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
      if (approvalRows.length === 0) {
        return { turns: [], approvals: [] };
      }

      const now = nowIso();
      this.db
        .prepare(
          `
          update approval
          set decision = 'orphaned', decided_by = 'bridge', decision_reason = ?, resolved_at = ?
          where decision is null
            and task_id in (select id from task where runtime_host_id = ?)
          `,
        )
        .run(reason, now, runtimeHostId);

      const turnIds = [
        ...new Set(
          approvalRows
            .map((row) => row.codex_turn_id)
            .filter((turnId): turnId is string => Boolean(turnId)),
        ),
      ];
      const turns: TurnRecord[] = [];
      const updateTurn = this.db.prepare(
        `
        update turn
        set status = 'interrupted', attention_revision = attention_revision + 1,
            attention_kind = 'interrupted', attention_payload_json = ?, updated_at = ?
        where codex_turn_id = ? and status = 'awaiting_approval'
        `,
      );
      const updateTask = this.db.prepare(
        "update task set status = 'interrupted', updated_at = ? where id = ?",
      );
      for (const turnId of turnIds) {
        const current = this.getTurnByCodexTurnId(turnId);
        if (!current) {
          continue;
        }
        const updated = updateTurn.run(
          toJson({
            type: "codex_turn_interrupted",
            reason,
            nextAction: "task_recover",
          }),
          now,
          turnId,
        );
        if (updated.changes > 0) {
          updateTask.run(now, current.taskId);
          const turn = this.getTurnByCodexTurnId(turnId);
          if (turn) {
            turns.push(turn);
          }
        }
      }

      return {
        turns,
        approvals: approvalRows.map((row) =>
          approvalFromRow({
            ...row,
            decision: "orphaned",
            decided_by: "bridge",
            decision_reason: reason,
            resolved_at: now,
          }),
        ),
      };
    });
    return tx();
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
          where task.runtime_host_id = ? and turn.status in ('running', 'awaiting_approval')
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
        "Approval was orphaned because its Runtime Host connection was lost; it cannot be answered on a replacement connection.";
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
          update turn
          set status = 'interrupted',
              attention_revision = attention_revision + 1,
              attention_kind = 'interrupted',
              attention_payload_json = ?,
              updated_at = ?
          where status in ('running', 'awaiting_approval')
            and task_id in (select id from task where runtime_host_id = ?)
          `,
        )
        .run(
          toJson({
            type: "codex_turn_interrupted",
            reason: "Runtime Host became unreachable.",
            nextAction: "task_recover",
          }),
          now,
          runtimeHostId,
        );
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
          set decision = 'orphaned', decided_by = 'bridge', decision_reason = ?, resolved_at = ?
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
            decision: "orphaned",
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
    const schemaVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (schemaVersion > 2) {
      throw new Error(`Bridge database schema ${schemaVersion} is newer than supported version 2.`);
    }
    const schemaPath = fileURLToPath(new URL("schema.sql", import.meta.url));
    this.db.exec(fs.readFileSync(schemaPath, "utf8"));
    this.ensureColumn("approval", "payload_json", "text");
    this.ensureColumn("turn", "attention_revision", "integer not null default 0");
    this.ensureColumn("turn", "attention_ack_revision", "integer not null default 0");
    this.ensureColumn("turn", "attention_kind", "text");
    this.ensureColumn("turn", "attention_payload_json", "text");
    this.ensureColumn("turn", "result_json", "text");
    this.enforceLifecycleConstraints();
    this.backfillProjectSessions();
    this.backfillTuiInstances();
    this.backfillPendingApprovalAttention();
    this.db.pragma("user_version = 2");
  }

  private enforceLifecycleConstraints(): void {
    const tx = this.db.transaction(() => {
      const now = nowIso();
      this.db
        .prepare(
          `
          update turn
          set status = 'interrupted', attention_revision = attention_revision + 1,
              attention_kind = 'interrupted', attention_payload_json = ?, updated_at = ?
          where status in ('running', 'awaiting_approval')
            and rowid not in (
              select max(rowid) from turn
              where status in ('running', 'awaiting_approval')
              group by task_id
            )
          `,
        )
        .run(
          toJson({
            type: "codex_turn_interrupted",
            reason: "Duplicate active turn repaired during Bridge lifecycle migration.",
            nextAction: "task_status",
          }),
          now,
        );
      this.db
        .prepare(
          `
          update task_command_queue
          set status = 'interrupted', finished_at = ?
          where status = 'running'
            and rowid not in (
              select max(rowid) from task_command_queue
              where status = 'running'
              group by task_id
            )
          `,
        )
        .run(now);
    });
    tx();
    this.db.exec(
      `
      create unique index if not exists idx_turn_one_active_per_task
        on turn(task_id) where status in ('running', 'awaiting_approval');
      create unique index if not exists idx_command_one_running_per_task
        on task_command_queue(task_id) where status = 'running';
      `,
    );
  }

  private backfillProjectSessions(): void {
    const taskRows = this.db.prepare("select * from task order by updated_at desc").all() as TaskRow[];
    const seen = new Set<string>();
    const insert = this.db.prepare(
      `
      insert or ignore into project_session (
        id, project_key, project_root, generation, runtime_host_id,
        active_task_id, codex_thread_id, status, claim_token,
        claim_expires_at, created_at, updated_at
      ) values (?, ?, ?, 1, ?, ?, ?, 'ACTIVE', null, null, ?, ?)
      `,
    );
    const tx = this.db.transaction(() => {
      for (const row of taskRows) {
        const canonical = canonicalizeProjectRoot(row.project_root);
        if (seen.has(canonical.projectKey)) {
          continue;
        }
        seen.add(canonical.projectKey);
        insert.run(
          createId("session"),
          canonical.projectKey,
          canonical.projectRoot,
          row.runtime_host_id,
          row.id,
          row.codex_thread_id,
          row.created_at,
          row.updated_at,
        );
      }
    });
    tx();
  }

  private backfillTuiInstances(): void {
    const sessions = this.db
      .prepare(
        `
        select * from project_session
        where active_task_id is not null and codex_thread_id is not null
        `,
      )
      .all() as ProjectSessionRow[];
    const findLaunch = this.db.prepare(
      `
      select * from event
      where task_id = ? and event_type = 'codex_tui_window_launched'
      order by seq desc limit 1
      `,
    );
    const insert = this.db.prepare(
      `
      insert or ignore into tui_instance (
        session_id, generation, runtime_endpoint, codex_thread_id, pid,
        process_started_at, status, claim_token, claim_expires_at,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, 'RUNNING', null, null, ?, ?)
      `,
    );
    const tx = this.db.transaction(() => {
      for (const row of sessions) {
        if (!row.active_task_id || !row.codex_thread_id || !row.runtime_host_id) {
          continue;
        }
        const runtime = this.getRuntime(row.runtime_host_id);
        const event = findLaunch.get(row.active_task_id) as EventRow | undefined;
        if (!runtime || !event) {
          continue;
        }
        const payload = fromJson<Record<string, unknown>>(event.payload_json, {});
        const pid = typeof payload.pid === "number" ? payload.pid : null;
        insert.run(
          row.id,
          row.generation,
          runtime.endpoint,
          row.codex_thread_id,
          pid,
          event.created_at,
          event.created_at,
          event.created_at,
        );
      }
    });
    tx();
  }

  private backfillPendingApprovalAttention(): void {
    const rows = this.db
      .prepare(
        `
        select approval.* from approval
        inner join turn on turn.task_id = approval.task_id
          and turn.codex_turn_id = approval.codex_turn_id
        where approval.decision is null
          and turn.status in ('running', 'awaiting_approval')
          and turn.attention_revision = 0
        order by approval.created_at asc
        `,
      )
      .all() as ApprovalRow[];
    const updateTurn = this.db.prepare(
      `
      update turn
      set status = 'awaiting_approval', attention_revision = 1,
          attention_kind = 'approval', attention_payload_json = ?, updated_at = ?
      where task_id = ? and codex_turn_id = ? and attention_revision = 0
      `,
    );
    const updateTask = this.db.prepare(
      "update task set status = 'awaiting_approval', updated_at = ? where id = ?",
    );
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const approval = approvalFromRow(row);
        const now = nowIso();
        updateTurn.run(
          toJson({
            type: "approval_requested",
            approvalId: approval.id,
            codexRequestId: approval.codexRequestId,
            kind: approval.kind,
            command: approval.command,
            cwd: approval.cwd,
            reason: approval.reason,
            riskSummary: approval.riskSummary,
            nextAction: "approval_decide",
          }),
          now,
          approval.taskId,
          approval.codexTurnId,
        );
        updateTask.run(now, approval.taskId);
      }
    });
    tx();
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

function projectSessionFromRow(row: ProjectSessionRow): ProjectSessionRecord {
  return {
    id: row.id,
    projectKey: row.project_key,
    projectRoot: row.project_root,
    generation: row.generation,
    runtimeHostId: row.runtime_host_id,
    activeTaskId: row.active_task_id,
    codexThreadId: row.codex_thread_id,
    status: row.status,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tuiInstanceFromRow(row: TuiInstanceRow): TuiInstanceRecord {
  return {
    sessionId: row.session_id,
    generation: row.generation,
    runtimeEndpoint: row.runtime_endpoint,
    codexThreadId: row.codex_thread_id,
    pid: row.pid,
    processStartedAt: row.process_started_at,
    status: row.status,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
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
    attentionRevision: row.attention_revision ?? 0,
    attentionAckRevision: row.attention_ack_revision ?? 0,
    attentionKind: row.attention_kind ?? null,
    attentionPayload: fromJson(row.attention_payload_json, null),
    result: fromJson(row.result_json, null),
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
