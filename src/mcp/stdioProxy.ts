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
  await ensureCoreReady(endpoint);

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

async function ensureCoreReady(endpoint: string): Promise<CoreHealth> {
  const initial = await probeCore(endpoint);
  if (initial?.status === "READY") {
    return assertCompatibleCore(initial);
  }
  if (!initial) {
    await spawnCoreDaemon();
  }

  const deadline = Date.now() + CORE_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await probeCore(endpoint);
    if (health?.status === "READY") {
      return assertCompatibleCore(health);
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

function assertCompatibleCore(health: CoreHealth): CoreHealth {
  if (
    health.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    health.buildId !== BRIDGE_BUILD_ID
  ) {
    throw new Error(
      `Codex Bridge Core PID ${health.pid} is running an incompatible build ` +
        `(core protocol=${health.protocolVersion ?? "unknown"}, build=${health.buildId ?? "unknown"}; ` +
        `adapter protocol=${BRIDGE_PROTOCOL_VERSION}, build=${BRIDGE_BUILD_ID}). ` +
        "Finish or recover active tasks, then restart that Core before reconnecting.",
    );
  }
  return health;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
