import { spawn } from "node:child_process";
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

type LaunchScript = (scriptPath: string, projectRoot: string) => Promise<number | null>;

export interface TuiProcessController {
  isAlive(pid: number | null): boolean;
  terminate(pid: number): void;
}

const defaultProcessController: TuiProcessController = {
  isAlive: isProcessAlive,
  terminate: terminateOwnedProcess,
};

const TUI_CLAIM_LEASE_MS = 30_000;
const TUI_WAIT_INTERVAL_MS = 50;
const TUI_STARTUP_GRACE_MS = 1_000;
const TUI_MONITOR_INTERVAL_MS = 1_000;

export class TuiWindowManager {
  private readonly processMonitors = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly store: SqliteStore,
    private readonly bridgeConfig: BridgeConfig = config,
    private readonly launchScript: LaunchScript = launchVisiblePowerShellScript,
    private readonly processController: TuiProcessController = defaultProcessController,
  ) {}

  async ensure(input: ManagedCodexTuiWindowInput): Promise<CodexTuiWindowResult> {
    if (this.bridgeConfig.codexTuiMode === "off") {
      return {
        launched: false,
        mode: "off",
        pid: null,
        reason: "Codex TUI window is disabled.",
      };
    }

    const claimToken = createId("tui_claim");
    const deadline = Date.now() + TUI_CLAIM_LEASE_MS + 5_000;
    while (Date.now() < deadline) {
      const running = this.getRunning(input);
      if (running.pid !== null) {
        return running;
      }

      const existing = this.store.getTuiInstance(input.sessionId);
      if (existing?.pid && this.processController.isAlive(existing.pid)) {
        this.stopMonitoring(input.sessionId);
        this.processController.terminate(existing.pid);
        await delay(100);
        this.store.markTuiExited(input.sessionId, existing.pid);
      }

      const claim = this.store.claimTuiLaunch({
        sessionId: input.sessionId,
        generation: input.sessionGeneration,
        runtimeEndpoint: input.endpoint,
        codexThreadId: input.threadId,
        claimToken,
        claimExpiresAt: new Date(Date.now() + TUI_CLAIM_LEASE_MS).toISOString(),
      });
      if (claim.outcome === "wait") {
        await delay(TUI_WAIT_INTERVAL_MS);
        continue;
      }

      let launchedPid: number | null = null;
      try {
        const result = await launchCodexTuiWindow(input, this.bridgeConfig, this.launchScript);
        launchedPid = result.pid;
        if (launchedPid === null) {
          throw new Error("Codex TUI launcher did not return a process id.");
        }
        await delay(TUI_STARTUP_GRACE_MS);
        if (!this.processController.isAlive(launchedPid)) {
          throw new Error(`Codex TUI process exited during startup: pid=${launchedPid}`);
        }
        this.store.completeTuiLaunch({
          sessionId: input.sessionId,
          claimToken,
          pid: launchedPid,
          processStartedAt: nowIso(),
        });
        this.monitorProcess(input.sessionId, launchedPid);
        return result;
      } catch (error) {
        if (launchedPid !== null && this.processController.isAlive(launchedPid)) {
          this.processController.terminate(launchedPid);
        }
        this.store.failTuiLaunch(input.sessionId, claimToken);
        throw error;
      }
    }

    throw new Error(`Timed out waiting for Codex TUI launch: ${input.sessionId}`);
  }

  getRunning(input: ManagedCodexTuiWindowInput): CodexTuiWindowResult {
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
        this.monitorProcess(input.sessionId, existing.pid);
        return {
          launched: false,
          mode: this.bridgeConfig.codexTuiMode,
          pid: existing.pid,
          reason: "Codex TUI window is already running for this project session.",
        };
      }
      this.stopMonitoring(input.sessionId);
      this.store.markTuiExited(input.sessionId, existing.pid);
    }

    return {
      launched: false,
      mode: this.bridgeConfig.codexTuiMode,
      pid: null,
      reason: "Codex TUI window is not running for this project session.",
    };
  }

  stop(): void {
    for (const monitor of this.processMonitors.values()) {
      clearInterval(monitor);
    }
    this.processMonitors.clear();
  }

  async invalidateEndpoint(endpoint: string): Promise<void> {
    const staleInstances = this.store.markTuiInstancesStale(endpoint);
    for (const instance of staleInstances) {
      this.stopMonitoring(instance.sessionId);
      if (instance.pid && this.processController.isAlive(instance.pid)) {
        this.processController.terminate(instance.pid);
      }
    }
  }

  private monitorProcess(sessionId: string, pid: number | null): void {
    if (pid === null || this.processMonitors.has(sessionId)) {
      return;
    }
    const monitor = setInterval(() => {
      if (this.processController.isAlive(pid)) {
        return;
      }
      this.stopMonitoring(sessionId);
      this.store.markTuiExited(sessionId, pid);
    }, TUI_MONITOR_INTERVAL_MS);
    monitor.unref();
    this.processMonitors.set(sessionId, monitor);
  }

  private stopMonitoring(sessionId: string): void {
    const monitor = this.processMonitors.get(sessionId);
    if (monitor) {
      clearInterval(monitor);
      this.processMonitors.delete(sessionId);
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

function terminateOwnedProcess(pid: number): void {
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
