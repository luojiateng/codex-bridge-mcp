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

export class TuiWindowManager {
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
      const existing = this.store.getTuiInstance(input.sessionId);
      const sameTarget =
        existing?.generation === input.sessionGeneration &&
        existing.runtimeEndpoint === input.endpoint &&
        existing.codexThreadId === input.threadId;
      if (
        existing?.status === "RUNNING" &&
        sameTarget &&
        this.processController.isAlive(existing.pid)
      ) {
        return {
          launched: false,
          mode: this.bridgeConfig.codexTuiMode,
          pid: existing.pid,
          reason: "Codex TUI window is already running for this project session.",
        };
      }

      if (existing?.pid && this.processController.isAlive(existing.pid)) {
        this.processController.terminate(existing.pid);
        await delay(100);
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

      try {
        const result = await launchCodexTuiWindow(input, this.bridgeConfig, this.launchScript);
        this.store.completeTuiLaunch({
          sessionId: input.sessionId,
          claimToken,
          pid: result.pid,
          processStartedAt: nowIso(),
        });
        return result;
      } catch (error) {
        this.store.failTuiLaunch(input.sessionId, claimToken);
        throw error;
      }
    }

    throw new Error(`Timed out waiting for Codex TUI launch: ${input.sessionId}`);
  }

  async invalidateEndpoint(endpoint: string): Promise<void> {
    const staleInstances = this.store.markTuiInstancesStale(endpoint);
    for (const instance of staleInstances) {
      if (instance.pid && this.processController.isAlive(instance.pid)) {
        this.processController.terminate(instance.pid);
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

function terminateOwnedProcess(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // The process may have exited between the liveness check and termination.
  }
}

function launchVisiblePowerShellScript(scriptPath: string, projectRoot: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const tuiProcess = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        cwd: projectRoot,
        detached: true,
        windowsHide: false,
        stdio: "ignore",
      },
    );
    tuiProcess.once("error", reject);
    tuiProcess.once("spawn", () => {
      const pid = tuiProcess.pid ?? null;
      tuiProcess.unref();
      resolve(pid);
    });
  });
}
