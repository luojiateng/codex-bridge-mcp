import { CodexClientPool, type CodexAppServerClient } from "../codex/codexAppServerClient.js";
import { config, type BridgeConfig } from "../config/config.js";
import { RuntimeHostManager } from "../runtime/runtimeHostManager.js";
import { TuiWindowManager } from "../runtime/tuiWindowManager.js";
import { JsonlLogger } from "../storage/jsonlLogger.js";
import { type RuntimeHostRecord, type TaskRecord, SqliteStore } from "../storage/sqlite.js";
import { buildCodexDeveloperInstructions } from "./codexInstruction.js";

export class RecoveryService {
  constructor(
    private readonly store: SqliteStore,
    private readonly runtimeHostManager: RuntimeHostManager,
    private readonly clientPool: CodexClientPool,
    private readonly logger: JsonlLogger,
    private readonly bridgeConfig: BridgeConfig = config,
    private readonly bindTaskRuntimeEvents: (
      task: TaskRecord,
      runtime: RuntimeHostRecord,
      client: CodexAppServerClient,
    ) => void = () => undefined,
    private readonly tuiWindowManager: TuiWindowManager = new TuiWindowManager(store, bridgeConfig),
  ) {}

  async recoverTask(taskId: string): Promise<{
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
    status: "recovered";
  }> {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`taskId not found: ${taskId}`);
    }
    const session = this.store.activateProjectSessionForTask(task);
    const runtime = await this.runtimeHostManager.recoverRuntime(task.runtimeHostId);
    const client = await this.clientPool.getOrConnect(runtime.endpoint);
    this.bindTaskRuntimeEvents(task, runtime, client);
    await client.ensureThreadReady(
      task.codexThreadId,
      task.projectRoot,
      buildCodexDeveloperInstructions(),
    );
    this.store.updateProjectSessionRuntime(session.id, runtime.id);
    const activeSession = this.store.getProjectSessionById(session.id) ?? session;
    const codexTui = await this.tuiWindowManager.ensure(
      {
        sessionId: activeSession.id,
        sessionGeneration: activeSession.generation,
        runtimeId: runtime.id,
        projectRoot: task.projectRoot,
        endpoint: runtime.endpoint,
        threadId: task.codexThreadId,
      },
    ).catch((error: unknown) => ({
      launched: false,
      mode: "off" as const,
      pid: null,
      reason: error instanceof Error ? error.message : String(error),
    }));
    const event = this.store.appendEvent({
      taskId: task.id,
      runtimeHostId: runtime.id,
      codexThreadId: task.codexThreadId,
      codexTurnId: null,
      eventType: "task_recovered",
      payload: {
        type: "task_recovered",
        runtimeEndpoint: runtime.endpoint,
        codexThreadId: task.codexThreadId,
        projectSessionId: activeSession.id,
        sessionGeneration: activeSession.generation,
        codexTui,
      },
    });
    await this.logger.append("tasks", task.id, event);
    return {
      taskId: task.id,
      runtimeHostId: runtime.id,
      runtimeEndpoint: runtime.endpoint,
      codexThreadId: task.codexThreadId,
      codexTui,
      status: "recovered",
    };
  }
}
