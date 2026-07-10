import { CodexClientPool } from "../codex/codexAppServerClient.js";
import { RuntimeHostManager } from "../runtime/runtimeHostManager.js";
import { JsonlLogger } from "../storage/jsonlLogger.js";
import { SqliteStore } from "../storage/sqlite.js";

export class CompactService {
  constructor(
    private readonly store: SqliteStore,
    private readonly runtimeHostManager: RuntimeHostManager,
    private readonly clientPool: CodexClientPool,
    private readonly logger: JsonlLogger,
  ) {}

  async compactTask(taskId: string): Promise<{ taskId: string; status: "compact_started" }> {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`taskId not found: ${taskId}`);
    }
    const runtime = await this.runtimeHostManager.ensureExistingRuntime(task.runtimeHostId);
    const client = await this.clientPool.getOrConnect(runtime.endpoint);
    await client.compactThread(task.codexThreadId, task.projectRoot);
    const event = this.store.appendEvent({
      taskId: task.id,
      runtimeHostId: runtime.id,
      codexThreadId: task.codexThreadId,
      codexTurnId: null,
      eventType: "context_compact_started",
      payload: { type: "context_compact_started", nextAction: "task_status" },
    });
    await this.logger.append("tasks", task.id, event);
    return { taskId, status: "compact_started" };
  }
}
