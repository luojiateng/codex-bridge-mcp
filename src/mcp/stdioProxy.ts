import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config/config.js";
import { BRIDGE_BUILD_ID, BRIDGE_PROTOCOL_VERSION } from "../shared/buildIdentity.js";
import { JsonlLogger } from "../storage/jsonlLogger.js";
import {
  formatBridgeHttpEndpoint,
  loadOrCreateMcpToken,
  resolveBridgeHttpAddress,
} from "./httpServer.js";

interface CoreHealth {
  service: "codex-bridge-mcp";
  status: string;
  pid: number;
  protocolVersion: number | null;
  buildId: string | null;
}

const CORE_START_TIMEOUT_MS = Number(
  process.env.CODEX_BRIDGE_CORE_START_TIMEOUT_MS ?? 20_000,
);
const UPSTREAM_REQUEST_TIMEOUT_MS = Number(
  process.env.CODEX_BRIDGE_MCP_UPSTREAM_TIMEOUT_MS ?? 86_400_000,
);

/**
 * Keeps stdio as the stable client contract while all durable state remains in
 * the one loopback Bridge Core process.
 */
export async function startStdioProxy(): Promise<void> {
  const address = resolveBridgeHttpAddress();
  const endpoint = formatBridgeHttpEndpoint(address);
  const { token } = await loadOrCreateMcpToken(config.dataDir);
  const logger = new JsonlLogger(config.logsDir);
  await ensureCoreReady(endpoint, token);

  const upstreamTransport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  const upstream = new Client(
    { name: "codex-bridge-stdio-adapter", version: "0.1.0" },
    { capabilities: {} },
  );
  await upstream.connect(upstreamTransport, { timeout: CORE_START_TIMEOUT_MS });

  const server = new Server(
    { name: "codex-bridge-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: upstream.getInstructions(),
    },
  );
  const requestOptions = (signal: AbortSignal) => ({
    signal,
    timeout: UPSTREAM_REQUEST_TIMEOUT_MS,
  });
  server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
    upstream.listTools(request.params, requestOptions(extra.signal)),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const downstreamProgressToken = extra._meta?.progressToken;
    try {
      const result = await upstream.callTool(request.params, undefined, {
        ...requestOptions(extra.signal),
        onprogress:
          downstreamProgressToken === undefined
            ? undefined
            : (progress) =>
                extra.sendNotification({
                  method: "notifications/progress",
                  params: {
                    ...progress,
                    progressToken: downstreamProgressToken,
                  },
                }),
      });
      void logger
        .append("runtime", `stdio-adapter-${process.pid}`, {
          type: "upstream_tool_result_received",
          requestId: extra.requestId,
          toolName: request.params.name,
        })
        .catch(() => undefined);
      return result;
    } catch (error) {
      void logger
        .append("runtime", `stdio-adapter-${process.pid}`, {
          type: "upstream_tool_request_failed",
          requestId: extra.requestId,
          toolName: request.params.name,
          aborted: extra.signal.aborted,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      throw error;
    }
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await Promise.allSettled([server.close(), upstream.close()]);
  };
  server.onclose = () => {
    void close();
  };
  upstream.onclose = () => {
    void close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  await server.connect(new StdioServerTransport());
}

async function ensureCoreReady(endpoint: string, token: string): Promise<CoreHealth> {
  const deadline = Date.now() + CORE_START_TIMEOUT_MS;
  let spawnAttempted = false;
  let upgradeRequestedPid: number | null = null;
  while (Date.now() < deadline) {
    const health = await probeCore(endpoint);
    if (!health) {
      if (!spawnAttempted) {
        await spawnCoreDaemon();
        spawnAttempted = true;
      }
      await delay(100);
      continue;
    }
    if (health?.status === "READY") {
      if (isCompatibleCore(health)) {
        return health;
      }
      if (upgradeRequestedPid !== health.pid) {
        const outcome = await requestCoreUpgrade(endpoint, token, health);
        if (outcome === "continue-current") {
          return health;
        }
        upgradeRequestedPid = health.pid;
        spawnAttempted = false;
      }
    }
    await delay(100);
  }
  throw new Error(`Codex Bridge Core did not become ready within ${CORE_START_TIMEOUT_MS}ms: ${endpoint}`);
}

async function spawnCoreDaemon(): Promise<void> {
  const daemonEntrypoint = fileURLToPath(new URL("../daemon.js", import.meta.url));
  const child = spawn(process.execPath, [daemonEntrypoint], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function probeCore(endpoint: string): Promise<CoreHealth | null> {
  try {
    const response = await fetch(new URL("/healthz", endpoint), {
      signal: AbortSignal.timeout(1_000),
    });
    const payload: unknown = await response.json();
    if (
      payload &&
      typeof payload === "object" &&
      "service" in payload &&
      payload.service === "codex-bridge-mcp" &&
      "status" in payload &&
      typeof payload.status === "string" &&
      "pid" in payload &&
      typeof payload.pid === "number"
    ) {
      return {
        service: "codex-bridge-mcp",
        status: payload.status,
        pid: payload.pid,
        protocolVersion:
          "protocolVersion" in payload && typeof payload.protocolVersion === "number"
            ? payload.protocolVersion
            : null,
        buildId: "buildId" in payload && typeof payload.buildId === "string" ? payload.buildId : null,
      };
    }
  } catch {
    // Absence is expected before the first stdio client starts the shared Core.
  }
  return null;
}

function isCompatibleCore(health: CoreHealth): boolean {
  return (
    health.protocolVersion === BRIDGE_PROTOCOL_VERSION &&
    health.buildId === BRIDGE_BUILD_ID
  );
}

async function requestCoreUpgrade(
  endpoint: string,
  token: string,
  health: CoreHealth,
): Promise<"draining" | "continue-current"> {
  let response: Response;
  try {
    response = await fetch(new URL("/admin/upgrade", endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        targetBuildId: BRIDGE_BUILD_ID,
      }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    if (!(await probeCore(endpoint))) {
      return "draining";
    }
    throw new Error(
      `Codex Bridge could not request automatic upgrade from Core PID ${health.pid}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const payload = await response.json().catch(() => null) as
    | { status?: string; blockers?: Record<string, unknown> }
    | null;
  if (response.status === 200 || response.status === 202) {
    return "draining";
  }
  if (response.status === 409) {
    const blockers = payload?.blockers
      ? Object.entries(payload.blockers)
          .filter(([, value]) => typeof value === "number" && value > 0)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")
      : "unknown activity";
    if (health.protocolVersion === BRIDGE_PROTOCOL_VERSION) {
      return "continue-current";
    }
    throw new Error(
      `Codex Bridge cannot continue through Core PID ${health.pid} because its protocol is incompatible and automatic upgrade is blocked by active work (${blockers}). The existing Core was left running and no task was interrupted.`,
    );
  }
  if (response.status === 404) {
    if (health.protocolVersion === BRIDGE_PROTOCOL_VERSION) {
      return "continue-current";
    }
    throw new Error(
      `Codex Bridge Core PID ${health.pid} predates automatic upgrade support. Its data was left untouched; stop this one legacy Core once, then future builds will switch automatically when idle.`,
    );
  }
  throw new Error(
    `Codex Bridge Core PID ${health.pid} rejected automatic upgrade with HTTP ${response.status}.`,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
