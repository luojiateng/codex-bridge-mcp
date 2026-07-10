import { CodexClientPool } from "../codex/codexAppServerClient.js";
import { config, type BridgeConfig } from "../config/config.js";
import { RuntimeHostManager } from "../runtime/runtimeHostManager.js";
import { launchCodexTuiWindow } from "../runtime/tuiWindowManager.js";
import { JsonlLogger } from "../storage/jsonlLogger.js";
import { SqliteStore } from "../storage/sqlite.js";
import { buildCodexDeveloperInstructions } from "./codexInstruction.js";

export class RecoveryService {
  constructor(
    private readonly store: SqliteStore,
    private readonly runtimeHostManager: RuntimeHostManager,
    private readonly clientPool: CodexClientPool,
    private readonly logger: JsonlLogger,
    private readonly bridgeConfig: BridgeConfig = config,
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
    const runtime = await this.runtimeHostManager.recoverRuntime(task.runtimeHostId);
    const client = await this.clientPool.getOrConnect(runtime.endpoint);
    await client.ensureThreadReady(
      task.codexThreadId,
      task.projectRoot,
      buildCodexDeveloperInstructions(),
    );
    const codexTui = await launchCodexTuiWindow(
      {
        runtimeId: runtime.id,
        projectRoot: task.projectRoot,
        endpoint: runtime.endpoint,
        threadId: task.codexThreadId,
      },
      this.bridgeConfig,
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
