import { spawn, spawnSync } from "node:child_process";
import { config, type BridgeConfig } from "../config/config.js";
import { createId, nowIso } from "../shared/id.js";
import { SqliteStore } from "../storage/sqlite.js";
import { delay } from "./heartbeat.js";
import { writeCodexTuiScript } from "./powershellScriptBuilder.js";

export interface CodexTuiWindowInput {
  runtimeId: string;
  projectRoot: string;
  endpoint: string;
  threadId: string;
}

export interface ManagedCodexTuiWindowInput extends CodexTuiWindowInput {
  sessionId: string;
  sessionGeneration: number;
}

export interface CodexTuiWindowResult {
  launched: boolean;
  mode: "off" | "remote" | "resume";
  pid: number | null;
  scriptPath?: string;
  reason?: string;
}

export type TuiEnsureTrigger =
  | "task_open"
  | "task_send"
  | "auto_relaunch"
  | "task_recover"
  | "startup";

export interface TuiEnsureOptions {
  trigger?: TuiEnsureTrigger;
}

export interface TuiLifecycleEvent {
  type:
    | "codex_tui_window_exited"
    | "codex_tui_relaunch_scheduled"
    | "codex_tui_window_relaunched"
    | "codex_tui_relaunch_failed"
    | "codex_tui_relaunch_suppressed"
    | "codex_tui_relaunch_circuit_opened";
  taskId: string;
  runtimeHostId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  projectSessionId: string;
  sessionGeneration: number;
  payload: Record<string, unknown>;
}

export interface TuiWindowManagerTiming {
  claimLeaseMs: number;
  waitIntervalMs: number;
  startupGraceMs: number;
  monitorIntervalMs: number;
  restartWindowMs: number;
  stableRuntimeMs: number;
  restartBackoffMs: readonly number[];
}

type LaunchScript = (scriptPath: string, projectRoot: string) => Promise<number | null>;

export interface TuiProcessController {
  isAlive(pid: number | null): boolean;
  terminate(pid: number): void;
}

const defaultProcessController: TuiProcessController = {
  isAlive: isProcessAlive,
  terminate: terminateOwnedProcess,
};

const DEFAULT_TIMING: TuiWindowManagerTiming = {
  claimLeaseMs: 30_000,
  waitIntervalMs: 50,
  startupGraceMs: 1_000,
  monitorIntervalMs: 1_000,
  restartWindowMs: 60_000,
  stableRuntimeMs: 60_000,
  restartBackoffMs: [0, 2_000, 5_000],
};

type TuiLifecycleListener = (event: TuiLifecycleEvent) => void | Promise<void>;

export class TuiWindowManager {
  private readonly processMonitors = new Map<string, ReturnType<typeof setInterval>>();
  private readonly relaunchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ensureOperations = new Map<string, Promise<CodexTuiWindowResult>>();
  private readonly timing: TuiWindowManagerTiming;
  private lifecycleListener: TuiLifecycleListener | null = null;
  private stopping = false;

  constructor(
    private readonly store: SqliteStore,
    private readonly bridgeConfig: BridgeConfig = config,
    private readonly launchScript: LaunchScript = launchVisiblePowerShellScript,
    private readonly processController: TuiProcessController = defaultProcessController,
    timing: Partial<TuiWindowManagerTiming> = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  setLifecycleListener(listener: TuiLifecycleListener | null): void {
    this.lifecycleListener = listener;
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.bridgeConfig.codexTuiMode === "off") {
      return;
    }

    for (const instance of this.store.listTuiInstances([
      "RUNNING",
      "EXITED",
      "RELAUNCH_WAIT",
      "FAILED",
    ])) {
      const input = this.resolveInput(instance.sessionId, instance.generation);
      if (!input) {
        continue;
      }
      if (instance.status === "RUNNING") {
        if (this.processController.isAlive(instance.pid)) {
          this.monitorProcess(input, instance.pid);
          continue;
        }
        await this.recordUnexpectedExit(input, instance.pid);
        continue;
      }
      if (
        instance.status === "FAILED" &&
        this.isCircuitOpen(instance.restartAttempts, instance.restartWindowStartedAt)
      ) {
        continue;
      }
      if (!this.shouldAutoRelaunch(input)) {
        if (instance.status === "RELAUNCH_WAIT") {
          this.store.cancelTuiRelaunch(input.sessionId, input.sessionGeneration);
          this.emitLifecycle(input, "codex_tui_relaunch_suppressed", {
            reason: "The auto-relaunch policy does not cover the current task state.",
          });
        }
        continue;
      }
      if (instance.status === "RELAUNCH_WAIT" && instance.nextRestartAt) {
        this.armRelaunchTimer(input, Math.max(0, Date.parse(instance.nextRestartAt) - Date.now()));
      } else {
        await this.scheduleAutoRelaunch(input, instance.lastError);
      }
    }
  }

  async ensure(
    input: ManagedCodexTuiWindowInput,
    options: TuiEnsureOptions = {},
  ): Promise<CodexTuiWindowResult> {
    if (this.bridgeConfig.codexTuiMode === "off") {
      return {
        launched: false,
        mode: "off",
        pid: null,
        reason: "Codex TUI window is disabled.",
      };
    }

    const trigger = options.trigger ?? "task_open";
    const key = this.instanceKey(input);
    const pending = this.ensureOperations.get(key);
    if (pending) {
      return pending;
    }
    const operation = this.ensureInternal(input, trigger).finally(() => {
      if (this.ensureOperations.get(key) === operation) {
        this.ensureOperations.delete(key);
      }
    });
    this.ensureOperations.set(key, operation);
    return operation;
  }

  private async ensureInternal(
    input: ManagedCodexTuiWindowInput,
    trigger: TuiEnsureTrigger,
  ): Promise<CodexTuiWindowResult> {
    const manualRecovery = trigger === "task_open" || trigger === "task_recover";
    if (trigger === "task_send" && this.bridgeConfig.codexTuiAutoRelaunch === "off") {
      const running = this.getRunning(input, false);
      if (running.pid !== null) {
        return running;
      }
      throw new Error(
        "Codex TUI is not running and automatic relaunch is disabled; call task_open with mode=reuse and expectedTaskId set to the active taskId to restore the visible session.",
      );
    }
    const current = this.store.getTuiInstance(input.sessionId);
    if (
      !manualRecovery &&
      current?.status === "FAILED" &&
      this.isCircuitOpen(current.restartAttempts, current.restartWindowStartedAt)
    ) {
      throw new Error(
        `Codex TUI auto-relaunch circuit is open for project session ${input.sessionId}; call task_open with mode=reuse and expectedTaskId set to the active taskId to retry manually.`,
      );
    }

    if (!manualRecovery && current?.status === "RELAUNCH_WAIT" && current.nextRestartAt) {
      const waitMs = Date.parse(current.nextRestartAt) - Date.now();
      if (waitMs > 0) {
        await delay(Math.min(waitMs, Math.max(...this.timing.restartBackoffMs, 0)));
      }
    }

    const claimToken = createId("tui_claim");
    const deadline = Date.now() + this.timing.claimLeaseMs + 5_000;
    while (Date.now() < deadline) {
      const running = this.getRunning(input, false);
      if (running.pid !== null) {
        return running;
      }

      const existing = this.store.getTuiInstance(input.sessionId);
      if (existing?.pid && this.processController.isAlive(existing.pid)) {
        this.stopMonitoring(input.sessionId);
        this.processController.terminate(existing.pid);
        await delay(100);
        this.store.markTuiExited(input.sessionId, existing.generation, existing.pid);
      }

      const claim = this.store.claimTuiLaunch({
        sessionId: input.sessionId,
        generation: input.sessionGeneration,
        runtimeEndpoint: input.endpoint,
        codexThreadId: input.threadId,
        claimToken,
        claimExpiresAt: new Date(Date.now() + this.timing.claimLeaseMs).toISOString(),
        resetRecovery: manualRecovery,
      });
      if (claim.outcome === "wait") {
        await delay(this.timing.waitIntervalMs);
        continue;
      }

      let launchedPid: number | null = null;
      try {
        const result = await launchCodexTuiWindow(input, this.bridgeConfig, this.launchScript);
        launchedPid = result.pid;
        if (launchedPid === null) {
          throw new Error("Codex TUI launcher did not return a process id.");
        }
        await delay(this.timing.startupGraceMs);
        if (!this.processController.isAlive(launchedPid)) {
          throw new Error(`Codex TUI process exited during startup: pid=${launchedPid}`);
        }
        this.store.completeTuiLaunch({
          sessionId: input.sessionId,
          claimToken,
          pid: launchedPid,
          processStartedAt: nowIso(),
        });
        this.cancelRelaunchTimer(input.sessionId);
        this.monitorProcess(input, launchedPid);
        if (trigger === "auto_relaunch") {
          this.emitLifecycle(input, "codex_tui_window_relaunched", {
            pid: launchedPid,
            restartAttempts: claim.instance.restartAttempts,
          });
        }
        return result;
      } catch (error) {
        if (launchedPid !== null && this.processController.isAlive(launchedPid)) {
          this.processController.terminate(launchedPid);
        }
        const reason = error instanceof Error ? error.message : String(error);
        this.store.failTuiLaunch(input.sessionId, claimToken, reason);
        throw error;
      }
    }

    throw new Error(`Timed out waiting for Codex TUI launch: ${input.sessionId}`);
  }

  getRunning(
    input: ManagedCodexTuiWindowInput,
    scheduleOnExit = true,
  ): CodexTuiWindowResult {
    if (this.bridgeConfig.codexTuiMode === "off") {
      return {
        launched: false,
        mode: "off",
        pid: null,
        reason: "Codex TUI window is disabled.",
      };
    }

    const existing = this.store.getTuiInstance(input.sessionId);
    const sameTarget =
      existing?.generation === input.sessionGeneration &&
      existing.runtimeEndpoint === input.endpoint &&
      existing.codexThreadId === input.threadId;
    if (existing?.status === "RUNNING" && sameTarget) {
      if (this.processController.isAlive(existing.pid)) {
        this.monitorProcess(input, existing.pid);
        return {
          launched: false,
          mode: this.bridgeConfig.codexTuiMode,
          pid: existing.pid,
          reason: "Codex TUI window is already running for this project session.",
        };
      }
      this.stopMonitoring(input.sessionId);
      const exited = this.store.markTuiExited(input.sessionId, existing.generation, existing.pid);
      if (exited) {
        this.emitLifecycle(input, "codex_tui_window_exited", {
          pid: existing.pid,
        });
        if (scheduleOnExit) {
          void this.scheduleAfterExit(input, exited.lastError).catch(() => undefined);
        }
      }
    }

    return {
      launched: false,
      mode: this.bridgeConfig.codexTuiMode,
      pid: null,
      reason: "Codex TUI window is not running for this project session.",
    };
  }

  stop(): void {
    this.stopping = true;
    for (const monitor of this.processMonitors.values()) {
      clearInterval(monitor);
    }
    this.processMonitors.clear();
    for (const timer of this.relaunchTimers.values()) {
      clearTimeout(timer);
    }
    this.relaunchTimers.clear();
  }

  async invalidateEndpoint(endpoint: string): Promise<void> {
    const staleInstances = this.store.markTuiInstancesStale(endpoint);
    for (const instance of staleInstances) {
      this.stopMonitoring(instance.sessionId);
      this.cancelRelaunchTimer(instance.sessionId);
      if (instance.pid && this.processController.isAlive(instance.pid)) {
        this.processController.terminate(instance.pid);
      }
    }
  }

  private monitorProcess(input: ManagedCodexTuiWindowInput, pid: number | null): void {
    if (pid === null || this.processMonitors.has(input.sessionId)) {
      return;
    }
    const monitor = setInterval(() => {
      if (this.processController.isAlive(pid)) {
        return;
      }
      this.stopMonitoring(input.sessionId);
      void this.recordUnexpectedExit(input, pid).catch(() => undefined);
    }, this.timing.monitorIntervalMs);
    monitor.unref();
    this.processMonitors.set(input.sessionId, monitor);
  }

  private stopMonitoring(sessionId: string): void {
    const monitor = this.processMonitors.get(sessionId);
    if (monitor) {
      clearInterval(monitor);
      this.processMonitors.delete(sessionId);
    }
  }

  private async recordUnexpectedExit(
    input: ManagedCodexTuiWindowInput,
    pid: number | null,
  ): Promise<void> {
    const exited = this.store.markTuiExited(input.sessionId, input.sessionGeneration, pid);
    if (!exited) {
      return;
    }
    this.emitLifecycle(input, "codex_tui_window_exited", { pid });
    await this.scheduleAfterExit(input, exited.lastError);
  }

  private async scheduleAfterExit(
    input: ManagedCodexTuiWindowInput,
    reason: string | null,
  ): Promise<void> {
    if (!this.shouldAutoRelaunch(input)) {
      this.emitLifecycle(input, "codex_tui_relaunch_suppressed", {
        reason: "The auto-relaunch policy does not cover the current task state.",
      });
      return;
    }
    await this.scheduleAutoRelaunch(input, reason);
  }

  private async scheduleAutoRelaunch(
    input: ManagedCodexTuiWindowInput,
    reason: string | null,
  ): Promise<void> {
    if (this.stopping) {
      return;
    }
    const instance = this.store.getTuiInstance(input.sessionId);
    if (!instance || instance.generation !== input.sessionGeneration) {
      return;
    }
    const now = Date.now();
    const windowStartedAt = Date.parse(instance.restartWindowStartedAt ?? "");
    const processStartedAt = Date.parse(instance.processStartedAt ?? "");
    const resetWindow =
      !Number.isFinite(windowStartedAt) ||
      now - windowStartedAt >= this.timing.restartWindowMs ||
      (Number.isFinite(processStartedAt) && now - processStartedAt >= this.timing.stableRuntimeMs);
    const restartWindowStartedAt = new Date(resetWindow ? now : windowStartedAt).toISOString();
    const restartAttempts = resetWindow ? 1 : instance.restartAttempts + 1;
    if (restartAttempts > this.timing.restartBackoffMs.length) {
      const circuitReason = `Codex TUI exited repeatedly; auto-relaunch stopped after ${this.timing.restartBackoffMs.length} attempts in ${this.timing.restartWindowMs}ms.`;
      const opened = this.store.openTuiRelaunchCircuit({
        sessionId: input.sessionId,
        generation: input.sessionGeneration,
        restartAttempts: this.timing.restartBackoffMs.length,
        restartWindowStartedAt,
        reason: circuitReason,
      });
      if (opened) {
        this.emitLifecycle(input, "codex_tui_relaunch_circuit_opened", {
          reason: circuitReason,
          restartAttempts: opened.restartAttempts,
        });
      }
      return;
    }

    const delayMs = this.timing.restartBackoffMs[restartAttempts - 1] ?? 0;
    const nextRestartAt = new Date(now + delayMs).toISOString();
    const scheduled = this.store.scheduleTuiRelaunch({
      sessionId: input.sessionId,
      generation: input.sessionGeneration,
      restartAttempts,
      restartWindowStartedAt,
      nextRestartAt,
      reason,
    });
    if (!scheduled) {
      return;
    }
    this.emitLifecycle(input, "codex_tui_relaunch_scheduled", {
      restartAttempts,
      delayMs,
      nextRestartAt,
      reason,
    });
    this.armRelaunchTimer(input, delayMs);
  }

  private armRelaunchTimer(input: ManagedCodexTuiWindowInput, delayMs: number): void {
    const key = this.instanceKey(input);
    if (this.relaunchTimers.has(key) || this.stopping) {
      return;
    }
    const timer = setTimeout(() => {
      this.relaunchTimers.delete(key);
      void this.runScheduledRelaunch(input);
    }, delayMs);
    timer.unref();
    this.relaunchTimers.set(key, timer);
  }

  private async runScheduledRelaunch(input: ManagedCodexTuiWindowInput): Promise<void> {
    const currentInput = this.resolveInput(input.sessionId, input.sessionGeneration);
    if (!currentInput) {
      this.store.cancelTuiRelaunch(input.sessionId, input.sessionGeneration);
      return;
    }
    if (this.stopping) {
      return;
    }
    if (!this.shouldAutoRelaunch(currentInput)) {
      this.store.cancelTuiRelaunch(currentInput.sessionId, currentInput.sessionGeneration);
      this.emitLifecycle(currentInput, "codex_tui_relaunch_suppressed", {
        reason: "The task became idle before the scheduled relaunch.",
      });
      return;
    }
    try {
      await this.ensure(currentInput, { trigger: "auto_relaunch" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.emitLifecycle(currentInput, "codex_tui_relaunch_failed", { reason });
      await this.scheduleAutoRelaunch(currentInput, reason);
    }
  }

  private shouldAutoRelaunch(input: ManagedCodexTuiWindowInput): boolean {
    if (
      this.stopping ||
      this.bridgeConfig.codexTuiMode === "off" ||
      this.bridgeConfig.codexTuiAutoRelaunch === "off"
    ) {
      return false;
    }
    const currentInput = this.resolveInput(input.sessionId, input.sessionGeneration);
    if (!currentInput) {
      return false;
    }
    if (this.bridgeConfig.codexTuiAutoRelaunch === "active-session") {
      return true;
    }
    const session = this.store.getProjectSessionById(input.sessionId);
    const latestTurn = session?.activeTaskId
      ? this.store.getLatestTurn(session.activeTaskId)
      : null;
    return latestTurn !== null && ["running", "awaiting_approval"].includes(latestTurn.status);
  }

  private resolveInput(
    sessionId: string,
    generation: number,
  ): ManagedCodexTuiWindowInput | null {
    const session = this.store.getProjectSessionById(sessionId);
    if (
      !session ||
      session.status !== "ACTIVE" ||
      session.generation !== generation ||
      !session.activeTaskId ||
      !session.runtimeHostId ||
      !session.codexThreadId
    ) {
      return null;
    }
    const task = this.store.getTask(session.activeTaskId);
    const runtime = this.store.getRuntime(session.runtimeHostId);
    if (
      !task ||
      !runtime ||
      runtime.status !== "RUNNING" ||
      task.codexThreadId !== session.codexThreadId
    ) {
      return null;
    }
    return {
      sessionId,
      sessionGeneration: generation,
      runtimeId: runtime.id,
      projectRoot: task.projectRoot,
      endpoint: runtime.endpoint,
      threadId: task.codexThreadId,
    };
  }

  private emitLifecycle(
    input: ManagedCodexTuiWindowInput,
    type: TuiLifecycleEvent["type"],
    payload: Record<string, unknown>,
  ): void {
    const session = this.store.getProjectSessionById(input.sessionId);
    const taskId = session?.activeTaskId;
    if (!taskId || !this.lifecycleListener) {
      return;
    }
    const latestTurn = this.store.getLatestTurn(taskId);
    void Promise.resolve(
      this.lifecycleListener({
        type,
        taskId,
        runtimeHostId: input.runtimeId,
        codexThreadId: input.threadId,
        codexTurnId: latestTurn?.codexTurnId ?? null,
        projectSessionId: input.sessionId,
        sessionGeneration: input.sessionGeneration,
        payload,
      }),
    ).catch(() => undefined);
  }

  private isCircuitOpen(restartAttempts: number, restartWindowStartedAt: string | null): boolean {
    const windowStartedAt = Date.parse(restartWindowStartedAt ?? "");
    return (
      restartAttempts >= this.timing.restartBackoffMs.length &&
      Number.isFinite(windowStartedAt) &&
      Date.now() - windowStartedAt < this.timing.restartWindowMs
    );
  }

  private instanceKey(input: ManagedCodexTuiWindowInput): string {
    return `${input.sessionId}:${input.sessionGeneration}`;
  }

  private cancelRelaunchTimer(sessionId: string): void {
    for (const [key, timer] of this.relaunchTimers) {
      if (key.startsWith(`${sessionId}:`)) {
        clearTimeout(timer);
        this.relaunchTimers.delete(key);
      }
    }
  }
}

export async function launchCodexTuiWindow(
  input: CodexTuiWindowInput,
  bridgeConfig: BridgeConfig = config,
  launchScript: LaunchScript = launchVisiblePowerShellScript,
): Promise<CodexTuiWindowResult> {
  if (bridgeConfig.codexTuiMode === "off") {
    return {
      launched: false,
      mode: "off",
      pid: null,
      reason: "Codex TUI window is disabled.",
    };
  }

  const scriptPath = await writeCodexTuiScript({
    runtimeScriptsDir: bridgeConfig.runtimeScriptsDir,
    projectRoot: input.projectRoot,
    runtimeId: input.runtimeId,
    endpoint: input.endpoint,
    threadId: input.threadId,
    mode: bridgeConfig.codexTuiMode,
  });
  const pid = await launchScript(scriptPath, input.projectRoot);
  return {
    launched: true,
    mode: bridgeConfig.codexTuiMode,
    pid,
    scriptPath,
  };
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function terminateOwnedProcess(pid: number): void {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.status === 0 || !isProcessAlive(pid)) {
      return;
    }
    const reason = result.error?.message ?? `taskkillStatus=${String(result.status)}`;
    throw new Error(`Failed to terminate TUI process tree: pid=${pid} reason=${reason}`);
  }
  try {
    process.kill(pid);
  } catch {
    // The process may have exited between the liveness check and termination.
  }
}

function launchVisiblePowerShellScript(scriptPath: string, projectRoot: string): Promise<number | null> {
  const command = [
    `$ErrorActionPreference = "Stop"`,
    `$scriptPath = ${psString(scriptPath)}`,
    `$projectRoot = ${psString(projectRoot)}`,
    `$args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath)`,
    `$process = Start-Process -FilePath "powershell.exe" -ArgumentList $args -WorkingDirectory $projectRoot -WindowStyle Normal -PassThru`,
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
            `Codex TUI launcher failed: code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`,
          ),
        );
        return;
      }
      const pid = Number.parseInt(stdout.trim(), 10);
      resolve(Number.isFinite(pid) ? pid : null);
    });
  });
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
