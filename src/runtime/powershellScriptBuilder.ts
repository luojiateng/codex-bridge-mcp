import fs from "node:fs/promises";
import path from "node:path";

export interface RuntimeScriptInput {
  runtimeScriptsDir: string;
  projectRoot: string;
  port: number;
  runtimeId: string;
  outputLogPath: string;
}

export interface CodexTuiScriptInput {
  runtimeScriptsDir: string;
  projectRoot: string;
  runtimeId: string;
  endpoint: string;
  threadId: string;
  mode: "remote" | "resume";
}

export async function writeRuntimeScript(input: RuntimeScriptInput): Promise<string> {
  await fs.mkdir(input.runtimeScriptsDir, { recursive: true });
  const scriptPath = path.join(input.runtimeScriptsDir, `${input.runtimeId}.ps1`);
  const title = `CodexRuntimeHost - ${input.runtimeId} - 127.0.0.1:${input.port}`;
  const content = [
    `$ErrorActionPreference = "Stop"`,
    `try { $Host.UI.RawUI.WindowTitle = ${psString(title)} } catch {}`,
    `$RuntimeLogPath = ${psString(input.outputLogPath)}`,
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RuntimeLogPath) | Out-Null`,
    `function Write-RuntimeLog([string]$Message) {`,
    `  $line = "[" + (Get-Date).ToString("o") + "] " + $Message`,
    `  Add-Content -LiteralPath $RuntimeLogPath -Value $line -Encoding UTF8`,
    `  Write-Host $Message`,
    `}`,
    `Set-Location -LiteralPath ${psString(input.projectRoot)}`,
    `Write-RuntimeLog "Starting Codex Runtime Host: ${input.runtimeId}"`,
    `Write-RuntimeLog "Project: ${input.projectRoot}"`,
    `Write-RuntimeLog "Endpoint: ws://127.0.0.1:${input.port}"`,
    `Write-RuntimeLog "Command: codex app-server --listen ws://127.0.0.1:${input.port}"`,
    `try {`,
    `  $CodexCommand = (Get-Command "codex.cmd" -ErrorAction SilentlyContinue | Select-Object -First 1).Source`,
    `  if (-not $CodexCommand) { $CodexCommand = (Get-Command "codex" -ErrorAction Stop | Select-Object -First 1).Source }`,
    `  $stdoutLogPath = [System.IO.Path]::ChangeExtension($RuntimeLogPath, ".stdout.log")`,
    `  $stderrLogPath = [System.IO.Path]::ChangeExtension($RuntimeLogPath, ".stderr.log")`,
    `  Write-RuntimeLog "Resolved Codex command: $CodexCommand"`,
    `  Write-RuntimeLog "Codex stdout log: $stdoutLogPath"`,
    `  Write-RuntimeLog "Codex stderr log: $stderrLogPath"`,
    `  $process = Start-Process -FilePath $CodexCommand -ArgumentList @("app-server", "--listen", "ws://127.0.0.1:${input.port}") -WorkingDirectory ${psString(input.projectRoot)} -NoNewWindow -RedirectStandardOutput $stdoutLogPath -RedirectStandardError $stderrLogPath -PassThru`,
    `  Write-RuntimeLog "Codex app-server process started: $($process.Id)"`,
    `  $process.WaitForExit()`,
    `  Write-RuntimeLog "Codex app-server exited with code $($process.ExitCode)"`,
  `} catch {`,
    `  Write-RuntimeLog ("Codex app-server failed: " + $_.Exception.Message)`,
    `  throw`,
    `}`,
    "",
  ].join("\r\n");
  await fs.writeFile(scriptPath, content, "utf8");
  return scriptPath;
}

export async function writeCodexTuiScript(input: CodexTuiScriptInput): Promise<string> {
  await fs.mkdir(input.runtimeScriptsDir, { recursive: true });
  const scriptPath = path.join(
    input.runtimeScriptsDir,
    `${input.runtimeId}-${input.threadId}.tui.ps1`,
  );
  const logPath = path.join(
    input.runtimeScriptsDir,
    `${input.runtimeId}-${input.threadId}.tui.log`,
  );
  const title = `Codex TUI - ${input.runtimeId} - ${input.threadId}`;
  const args =
    input.mode === "resume"
      ? [
          "resume",
          "--remote",
          input.endpoint,
          "--cd",
          input.projectRoot,
          input.threadId,
        ]
      : ["--remote", input.endpoint, "--cd", input.projectRoot];
  const content = [
    `$ErrorActionPreference = "Continue"`,
    `try { $Host.UI.RawUI.WindowTitle = ${psString(title)} } catch {}`,
    `Set-Location -LiteralPath ${psString(input.projectRoot)}`,
    `$TuiLogPath = ${psString(logPath)}`,
    `$CodexArgs = @(${args.map(psString).join(", ")})`,
    `function Write-TuiLog([string]$Message) {`,
    `  $line = "[" + (Get-Date).ToString("o") + "] " + $Message`,
    `  Add-Content -LiteralPath $TuiLogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue`,
    `  Write-Host $Message`,
    `}`,
    `Write-TuiLog "Starting Codex TUI window"`,
    `Write-TuiLog "Project: ${input.projectRoot}"`,
    `Write-TuiLog "Endpoint: ${input.endpoint}"`,
    `Write-TuiLog "Thread: ${input.threadId}"`,
    `Write-TuiLog "Mode: ${input.mode}"`,
    `try {`,
    `  $CodexCommand = (Get-Command "codex.cmd" -ErrorAction SilentlyContinue | Select-Object -First 1).Source`,
    `  if (-not $CodexCommand) { $CodexCommand = (Get-Command "codex" -ErrorAction Stop | Select-Object -First 1).Source }`,
    `  Write-TuiLog "Resolved Codex command: $CodexCommand"`,
    ...(input.mode === "resume"
      ? [
          `  $retryDelaySeconds = 2`,
          `  $minSuccessfulRunSeconds = 5`,
          `  $attempt = 0`,
          `  while ($true) {`,
          `    $attempt += 1`,
          `    Write-TuiLog "Attempt $($attempt): $CodexCommand $($CodexArgs -join ' ')"`,
          `    $attemptStart = Get-Date`,
          `    & $CodexCommand @CodexArgs`,
          `    $exitCode = $LASTEXITCODE`,
          `    $elapsedSeconds = ((Get-Date) - $attemptStart).TotalSeconds`,
          `    Write-TuiLog "Codex TUI exited with code $exitCode after $([math]::Round($elapsedSeconds, 1))s"`,
          `    if ($elapsedSeconds -ge $minSuccessfulRunSeconds) { break }`,
          `    Write-TuiLog "Thread rollout is not ready; retrying in $retryDelaySeconds s..."`,
          `    Start-Sleep -Seconds $retryDelaySeconds`,
          `  }`,
        ]
      : [
          `  Write-TuiLog ("Command: " + $CodexCommand + " " + ($CodexArgs -join " "))`,
          `  & $CodexCommand @CodexArgs`,
          `  Write-TuiLog "Codex TUI exited with code $LASTEXITCODE"`,
        ]),
    `} catch {`,
    `  Write-TuiLog ("Codex TUI failed: " + $_.Exception.Message)`,
    `  throw`,
    `}`,
    "",
  ].join("\r\n");
  await fs.writeFile(scriptPath, content, "utf8");
  return scriptPath;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
