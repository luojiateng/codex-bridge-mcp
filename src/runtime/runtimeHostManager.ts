import { spawn } from "node:child_process";
import path from "node:path";
import { config, type BridgeConfig } from "../config/config.js";
import { JsonlLogger } from "../storage/jsonlLogger.js";
import {
  type RuntimeDependentsInterrupted,
  type RuntimeHostRecord,
  type RuntimeStatus,
  SqliteStore,
} from "../storage/sqlite.js";
import { createRuntimeId, nowIso } from "../shared/id.js";
import { CodexClientPool } from "../codex/codexAppServerClient.js";
import { allocateStablePort } from "./portAllocator.js";
import { isHttpReady, waitForHttpReady } from "./heartbeat.js";
import { writeRuntimeScript } from "./powershellScriptBuilder.js";
import { invalidateCodexTuiWindows } from "./tuiWindowManager.js";

export class RuntimeHostManager {
  private readonly ensuringByProjectRoot = new Map<string, Promise<RuntimeHostRecord>>();

  constructor(
    private readonly store: SqliteStore,
    private readonly logger: JsonlLogger,
    private readonly clientPool: CodexClientPool,
    private readonly bridgeConfig: BridgeConfig = config,
  ) {}

  async ensureRuntimeHost(projectRoot: string): Promise<RuntimeHostRecord> {
    const normalizedProjectRoot = path.resolve(projectRoot);
    const existingEnsure = this.ensuringByProjectRoot.get(normalizedProjectRoot);
    if (existingEnsure) {
      return existingEnsure;
    }

    let trackedEnsure: Promise<RuntimeHostRecord>;
    trackedEnsure = this.ensureRuntimeHostInternal(normalizedProjectRoot).finally(() => {
      if (this.ensuringByProjectRoot.get(normalizedProjectRoot) === trackedEnsure) {
        this.ensuringByProjectRoot.delete(normalizedProjectRoot);
      }
    });
    this.ensuringByProjectRoot.set(normalizedProjectRoot, trackedEnsure);
    return trackedEnsure;
  }

  private async ensureRuntimeHostInternal(projectRoot: string): Promise<RuntimeHostRecord> {
    const existing = this.store.findRuntimeByProjectRoot(projectRoot);
    if (existing) {
      const alive = await isHttpReady(existing.endpoint, this.bridgeConfig.runtimeReconnectTimeoutMs);
      if (alive) {
        this.store.markRuntimeHeartbeat(existing.id);
        return { ...existing, status: "RUNNING", lastHeartbeatAt: nowIso(), updatedAt: nowIso() };
      }

      await this.transition(existing, "RECONNECTING");
      const reconnected = await isHttpReady(
        existing.endpoint,
        this.bridgeConfig.runtimeReconnectTimeoutMs,
      );
      if (reconnected) {
        this.store.markRuntimeHeartbeat(existing.id);
        return { ...existing, status: "RUNNING", lastHeartbeatAt: nowIso(), updatedAt: nowIso() };
      }

      await this.transition(existing, "DEAD");
      invalidateCodexTuiWindows(existing.endpoint);
      await this.interruptRuntimeDependents(
        existing.id,
        "Runtime Host was unreachable and marked DEAD; its running work was interrupted before recreation.",
      );
    }

    return this.startRuntimeHost(projectRoot, existing?.id);
  }

  async ensureExistingRuntime(runtimeHostId: string): Promise<RuntimeHostRecord> {
    const runtime = this.store.getRuntime(runtimeHostId);
    if (!runtime) {
      throw new Error(`runtimeHostId not found: ${runtimeHostId}`);
    }
    const alive = await isHttpReady(runtime.endpoint, this.bridgeConfig.runtimeReconnectTimeoutMs);
    if (alive) {
      this.store.markRuntimeHeartbeat(runtime.id);
      return { ...runtime, status: "RUNNING", lastHeartbeatAt: nowIso(), updatedAt: nowIso() };
    }

    await this.transition(runtime, "DISCONNECTED");
    return this.ensureRuntimeHost(runtime.projectRoot);
  }

  async recoverRuntime(runtimeHostId: string): Promise<RuntimeHostRecord> {
    const runtime = this.store.getRuntime(runtimeHostId);
    if (!runtime) {
      throw new Error(`runtimeHostId not found: ${runtimeHostId}`);
    }
    this.clientPool.drop(runtime.endpoint);
    return this.ensureRuntimeHost(runtime.projectRoot);
  }

  async interruptRuntimeDependents(
    runtimeHostId: string,
    reason: string,
  ): Promise<RuntimeDependentsInterrupted> {
    const interrupted = this.store.markRuntimeDependentsInterrupted(runtimeHostId);
    const tasksById = new Map(interrupted.tasks.map((task) => [task.id, task]));

    for (const turn of interrupted.turns) {
      const task = tasksById.get(turn.taskId);
      if (!task) {
        continue;
      }
      const event = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId,
        codexThreadId: turn.codexThreadId,
        codexTurnId: turn.codexTurnId,
        eventType: "codex_turn_interrupted",
        payload: {
          type: "codex_turn_interrupted",
          codexTurnId: turn.codexTurnId,
          interruptedAt: turn.updatedAt,
          reason,
          nextAction: "task_status",
        },
      });
      await this.logger.append("tasks", task.id, event);
    }

    for (const command of interrupted.commands) {
      const task = tasksById.get(command.taskId);
      if (!task) {
        continue;
      }
      const event = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId,
        codexThreadId: task.codexThreadId,
        codexTurnId: null,
        eventType: "task_command_interrupted",
        payload: {
          type: "task_command_interrupted",
          commandId: command.id,
          startedAt: command.startedAt,
          reason,
          nextAction: "task_status",
        },
      });
      await this.logger.append("tasks", task.id, event);
    }

    for (const approval of interrupted.approvals) {
      const task = tasksById.get(approval.taskId);
      if (!task) {
        continue;
      }
      const event = this.store.appendEvent({
        taskId: task.id,
        runtimeHostId,
        codexThreadId: approval.codexThreadId,
        codexTurnId: approval.codexTurnId,
        eventType: "approval_auto_denied",
        payload: {
          type: "approval_auto_denied",
          approvalId: approval.id,
          decision: approval.decision,
          decidedBy: approval.decidedBy,
          decisionReason: approval.decisionReason,
          resolvedAt: approval.resolvedAt,
          reason,
          nextAction: "task_status",
        },
      });
      await this.logger.append("tasks", task.id, event);
    }

    return interrupted;
  }

  private async startRuntimeHost(
    projectRoot: string,
    previousRuntimeId: string | undefined,
  ): Promise<RuntimeHostRecord> {
    const port = await allocateStablePort(
      projectRoot,
      this.bridgeConfig.runtimePortBase,
      this.bridgeConfig.runtimePortSpan,
    );
    const runtimeId = previousRuntimeId ?? createRuntimeId(projectRoot, port);
    const endpoint = `ws://127.0.0.1:${port}`;
    const startedAt = nowIso();
    const starting: RuntimeHostRecord = {
      id: runtimeId,
      projectRoot,
      port,
      endpoint,
      pid: null,
      windowTitle: `CodexRuntimeHost - ${runtimeId}`,
      status: "STARTING",
      startedAt,
      lastHeartbeatAt: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    this.store.saveRuntime(starting);
    await this.logger.append("runtime", runtimeId, {
      type: "runtime_starting",
      runtimeId,
      projectRoot,
      endpoint,
    });

    const outputLogPath = path.join(this.bridgeConfig.logsDir, "runtime", `${runtimeId}.host.log`);
    const scriptPath = await writeRuntimeScript({
      runtimeScriptsDir: this.bridgeConfig.runtimeScriptsDir,
      projectRoot,
      port,
      runtimeId,
      outputLogPath,
    });

    const launched = await launchPowerShellHost(
      scriptPath,
      projectRoot,
      this.bridgeConfig.runtimeHostWindow,
    );
    await this.logger.append("runtime", runtimeId, {
      type: "runtime_process_launched",
      runtimeId,
      pid: launched.pid,
      endpoint,
      scriptPath,
      outputLogPath,
      launcherStdout: launched.stdout,
      launcherStderr: launched.stderr,
    });

    await waitForHttpReady(endpoint, this.bridgeConfig.runtimeStartTimeoutMs);

    const now = nowIso();
    const runtime: RuntimeHostRecord = {
      ...starting,
      pid: launched.pid,
      status: previousRuntimeId ? "RECREATED" : "RUNNING",
      lastHeartbeatAt: now,
      updatedAt: now,
    };
    this.store.saveRuntime(runtime);
    this.store.markRuntimeStatus(runtime.id, "RUNNING");
    await this.logger.append("runtime", runtimeId, {
      type: "runtime_running",
      runtimeId,
      pid: runtime.pid,
      endpoint,
      scriptPath,
      outputLogPath,
    });
    return { ...runtime, status: "RUNNING" };
  }

  private async transition(runtime: RuntimeHostRecord, status: RuntimeStatus): Promise<void> {
    this.store.markRuntimeStatus(runtime.id, status);
    await this.logger.append("runtime", runtime.id, {
      type: "runtime_status_changed",
      runtimeId: runtime.id,
      from: runtime.status,
      to: status,
      endpoint: runtime.endpoint,
    });
  }
}

function launchPowerShellHost(
  scriptPath: string,
  projectRoot: string,
  windowMode: "hidden" | "visible",
): Promise<{ pid: number | null; stdout: string; stderr: string }> {
  const windowStyle = windowMode === "visible" ? "Normal" : "Hidden";
  const command = [
    `$ErrorActionPreference = "Stop"`,
    `$scriptPath = ${psString(scriptPath)}`,
    `$projectRoot = ${psString(projectRoot)}`,
    `$args = @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath)`,
    `$process = Start-Process -FilePath "powershell.exe" -ArgumentList $args -WorkingDirectory $projectRoot -WindowStyle ${windowStyle} -PassThru`,
    `Write-Output $process.Id`,
  ].join("; ");

  return new Promise((resolve, reject) => {
    const launcher = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    launcher.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    launcher.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    launcher.once("error", reject);
    launcher.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `Runtime Host launcher failed: code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`,
          ),
        );
        return;
      }
      const pid = Number.parseInt(stdout.trim(), 10);
      resolve({
        pid: Number.isFinite(pid) ? pid : null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
