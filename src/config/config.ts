import path from "node:path";

export interface BridgeConfig {
  dataDir: string;
  dbPath: string;
  logsDir: string;
  runtimeScriptsDir: string;
  runtimePortBase: number;
  runtimePortSpan: number;
  runtimeStartTimeoutMs: number;
  runtimeReconnectTimeoutMs: number;
  appServerClientName: string;
  appServerClientTitle: string;
  appServerClientVersion: string;
  codexModel: string | null;
  codexReasoningEffort: string | null;
  codexReasoningSummary: "auto" | "concise" | "detailed" | "none" | null;
  codexVerbosity: "low" | "medium" | "high" | null;
  codexServiceTier: string | null;
  codexTuiMode: "off" | "remote" | "resume";
  runtimeHostWindow: "hidden" | "visible";
}

const projectRoot = process.cwd();
const dataDir = process.env.CODEX_BRIDGE_DATA_DIR ?? path.join(projectRoot, "data");

export const config: BridgeConfig = {
  dataDir,
  dbPath: process.env.CODEX_BRIDGE_DB_PATH ?? path.join(dataDir, "bridge.db"),
  logsDir: process.env.CODEX_BRIDGE_LOGS_DIR ?? path.join(dataDir, "logs"),
  runtimeScriptsDir:
    process.env.CODEX_BRIDGE_RUNTIME_SCRIPTS_DIR ?? path.join(dataDir, "runtime-scripts"),
  runtimePortBase: Number(process.env.CODEX_BRIDGE_PORT_BASE ?? 4510),
  runtimePortSpan: Number(process.env.CODEX_BRIDGE_PORT_SPAN ?? 400),
  runtimeStartTimeoutMs: Number(process.env.CODEX_BRIDGE_RUNTIME_START_TIMEOUT_MS ?? 30_000),
  runtimeReconnectTimeoutMs: Number(process.env.CODEX_BRIDGE_RUNTIME_RECONNECT_TIMEOUT_MS ?? 3_000),
  appServerClientName: "codex_bridge_mcp",
  appServerClientTitle: "Codex Bridge MCP",
  appServerClientVersion: "0.1.0",
  codexModel: process.env.CODEX_BRIDGE_CODEX_MODEL ?? null,
  codexReasoningEffort: process.env.CODEX_BRIDGE_CODEX_EFFORT ?? null,
  codexReasoningSummary: process.env.CODEX_BRIDGE_CODEX_SUMMARY
    ? parseSummary(process.env.CODEX_BRIDGE_CODEX_SUMMARY)
    : null,
  codexVerbosity: process.env.CODEX_BRIDGE_CODEX_VERBOSITY
    ? parseVerbosity(process.env.CODEX_BRIDGE_CODEX_VERBOSITY)
    : null,
  codexServiceTier: process.env.CODEX_BRIDGE_CODEX_SERVICE_TIER ?? null,
  codexTuiMode: parseTuiMode(
    process.env.CODEX_BRIDGE_CODEX_TUI_MODE ??
      (parseBoolean(process.env.CODEX_BRIDGE_SHOW_CODEX_TUI, true) ? "resume" : "off"),
  ),
  runtimeHostWindow: parseRuntimeHostWindow(process.env.CODEX_BRIDGE_RUNTIME_HOST_WINDOW ?? "hidden"),
};

function parseSummary(value: string): BridgeConfig["codexReasoningSummary"] {
  return value === "auto" || value === "concise" || value === "detailed" || value === "none"
    ? value
    : null;
}

function parseVerbosity(value: string): BridgeConfig["codexVerbosity"] {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function parseTuiMode(value: string): BridgeConfig["codexTuiMode"] {
  return value === "off" || value === "remote" || value === "resume" ? value : "resume";
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function parseRuntimeHostWindow(value: string): BridgeConfig["runtimeHostWindow"] {
  return value === "visible" ? "visible" : "hidden";
}
