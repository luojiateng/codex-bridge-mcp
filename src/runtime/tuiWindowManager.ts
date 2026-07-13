import { spawn } from "node:child_process";
import { config, type BridgeConfig } from "../config/config.js";
import { writeCodexTuiScript } from "./powershellScriptBuilder.js";

export interface CodexTuiWindowInput {
  runtimeId: string;
  projectRoot: string;
  endpoint: string;
  threadId: string;
}

export interface CodexTuiWindowResult {
  launched: boolean;
  mode: "off" | "remote" | "resume";
  pid: number | null;
  scriptPath?: string;
  reason?: string;
}

const launchedThreads = new Map<string, number | null>();

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

export async function launchCodexTuiWindow(
  input: CodexTuiWindowInput,
  bridgeConfig: BridgeConfig = config,
  launchScript: (
    scriptPath: string,
    projectRoot: string,
  ) => Promise<number | null> = launchVisiblePowerShellScript,
): Promise<CodexTuiWindowResult> {
  if (bridgeConfig.codexTuiMode === "off") {
    return {
      launched: false,
      mode: "off",
      pid: null,
      reason: "Codex TUI window is disabled.",
    };
  }

  const key = `${input.endpoint}:${input.threadId}`;
  const existingPid = launchedThreads.get(key);
  if (existingPid !== undefined && isProcessAlive(existingPid)) {
    return {
      launched: false,
      mode: bridgeConfig.codexTuiMode,
      pid: existingPid,
      reason: "Codex TUI window is already running for this thread.",
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
  launchedThreads.set(key, pid);
  return {
    launched: true,
    mode: bridgeConfig.codexTuiMode,
    pid,
    scriptPath,
  };
}

export function invalidateCodexTuiWindows(endpoint: string): void {
  const keyPrefix = `${endpoint}:`;
  for (const key of launchedThreads.keys()) {
    if (key.startsWith(keyPrefix)) {
      launchedThreads.delete(key);
    }
  }
}

function launchVisiblePowerShellScript(scriptPath: string, projectRoot: string): Promise<number | null> {
  const command = [
    `$ErrorActionPreference = "Stop"`,
    `$scriptPath = ${psString(scriptPath)}`,
    `$projectRoot = ${psString(projectRoot)}`,
    `$args = @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath)`,
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
