import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeCore } from "../core/bridgeCore.js";
import { BRIDGE_BUILD_ID, BRIDGE_PROTOCOL_VERSION } from "../shared/buildIdentity.js";
import { createMcpServer } from "./server.js";

export interface BridgeHttpOptions {
  host: string;
  port: number;
  path: string;
  authToken: string;
}

export type BridgeHttpAddress = Omit<BridgeHttpOptions, "authToken">;

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export class BridgeHttpServer {
  private readonly sessions = new Map<string, McpSession>();
  private httpServer: Server | null = null;

  constructor(
    private readonly core: BridgeCore,
    private readonly options: BridgeHttpOptions,
  ) {}

  get endpoint(): string {
    const address = this.httpServer?.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    return formatBridgeHttpEndpoint({ ...this.options, port });
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }
    validateOptions(this.options);
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          sendJson(response, 500, {
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
            id: null,
          });
        } else {
          response.end();
        }
      });
    });
    this.httpServer = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.port, this.options.host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      // The loopback listener is the process-level ownership lease. Acquire it
      // before opening SQLite or App Server sockets so a second Bridge process
      // cannot briefly run startup recovery against the same durable state.
      await this.core.start();
    } catch (error) {
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      await this.core.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    for (const session of this.sessions.values()) {
      await session.server.close().catch(() => undefined);
    }
    this.sessions.clear();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await this.core.stop();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      sendJson(response, this.core.state === "READY" ? 200 : 503, {
        service: "codex-bridge-mcp",
        status: this.core.state,
        pid: process.pid,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        buildId: BRIDGE_BUILD_ID,
      });
      return;
    }
    if (url.pathname === "/admin/upgrade") {
      await this.handleUpgradeRequest(request, response);
      return;
    }
    if (url.pathname !== this.options.path) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (this.core.state !== "READY") {
      sendJson(response, 503, rpcError(`Bridge Core is ${this.core.state}`));
      return;
    }
    if (!isAllowedOrigin(request.headers.origin)) {
      sendJson(response, 403, { error: "Origin is not allowed" });
      return;
    }
    if (!hasValidBearerToken(request.headers.authorization, this.options.authToken)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    const sessionId = headerValue(request.headers["mcp-session-id"]);
    if (request.method === "POST") {
      const body = await readJsonBody(request);
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          sendJson(response, 404, rpcError("Unknown MCP session"));
          return;
        }
        await session.transport.handleRequest(request, response, body);
        return;
      }
      if (!isInitializeRequest(body)) {
        sendJson(response, 400, rpcError("Initialize request or MCP session id required"));
        return;
      }
      await this.initializeSession(request, response, body);
      return;
    }

    if (request.method === "GET" || request.method === "DELETE") {
      if (!sessionId) {
        sendJson(response, 400, rpcError("MCP session id required"));
        return;
      }
      const session = this.sessions.get(sessionId);
      if (!session) {
        sendJson(response, 404, rpcError("Unknown MCP session"));
        return;
      }
      await session.transport.handleRequest(request, response);
      return;
    }

    response.setHeader("Allow", "GET, POST, DELETE");
    sendJson(response, 405, { error: "Method not allowed" });
  }

  private async handleUpgradeRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAllowedOrigin(request.headers.origin)) {
      sendJson(response, 403, { error: "Origin is not allowed" });
      return;
    }
    if (!hasValidBearerToken(request.headers.authorization, this.options.authToken)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    const body = await readJsonBody(request);
    const targetBuildId =
      body &&
      typeof body === "object" &&
      "targetBuildId" in body &&
      typeof body.targetBuildId === "string"
        ? body.targetBuildId
        : null;
    if (targetBuildId === BRIDGE_BUILD_ID) {
      sendJson(response, 200, {
        status: "current",
        pid: process.pid,
        buildId: BRIDGE_BUILD_ID,
      });
      return;
    }
    const readiness = this.core.beginUpgrade();
    if (!readiness.safe) {
      sendJson(response, 409, {
        status: "blocked",
        pid: process.pid,
        buildId: BRIDGE_BUILD_ID,
        targetBuildId,
        state: readiness.state,
        blockers: readiness.blockers,
      });
      return;
    }
    response.setHeader("Connection", "close");
    sendJson(response, 202, {
      status: "draining",
      pid: process.pid,
      buildId: BRIDGE_BUILD_ID,
      targetBuildId,
    });
    setImmediate(() => {
      void this.stop().catch((error: unknown) => {
        console.error(
          `Codex Bridge automatic upgrade shutdown failed: ${
            error instanceof Error ? error.stack ?? error.message : String(error)
          }`,
        );
      });
    });
  }

  private async initializeSession(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, { server, transport });
      },
    });
    const server = createMcpServer(this.core.services);
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        this.sessions.delete(sessionId);
      }
    };
    await server.connect(transport);
    try {
      await transport.handleRequest(request, response, body);
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
  }
}

export function resolveBridgeHttpAddress(): BridgeHttpAddress {
  return {
    host: process.env.CODEX_BRIDGE_HTTP_HOST ?? "127.0.0.1",
    port: Number(process.env.CODEX_BRIDGE_HTTP_PORT ?? 43_110),
    path: process.env.CODEX_BRIDGE_HTTP_PATH ?? "/mcp",
  };
}

export function formatBridgeHttpEndpoint(address: BridgeHttpAddress): string {
  const host = address.host === "::1" ? "[::1]" : address.host;
  return `http://${host}:${address.port}${address.path}`;
}

export async function loadOrCreateMcpToken(dataDir: string): Promise<{
  token: string;
  tokenPath: string;
  source: "environment" | "file";
}> {
  const tokenPath = path.join(dataDir, "mcp-token");
  const environmentToken = process.env.CODEX_BRIDGE_MCP_TOKEN?.trim();
  if (environmentToken) {
    return { token: environmentToken, tokenPath, source: "environment" };
  }
  try {
    const existing = (await fs.readFile(tokenPath, "utf8")).trim();
    if (existing) {
      return { token: existing, tokenPath, source: "file" };
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  await fs.mkdir(dataDir, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  await fs.writeFile(tokenPath, `${token}\n`, { encoding: "utf8", flag: "wx" }).catch(
    async (error: unknown) => {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EEXIST") {
        throw error;
      }
    },
  );
  const persisted = (await fs.readFile(tokenPath, "utf8")).trim();
  return { token: persisted, tokenPath, source: "file" };
}

function validateOptions(options: BridgeHttpOptions): void {
  if (options.host !== "127.0.0.1" && options.host !== "::1" && options.host !== "localhost") {
    throw new Error("Codex Bridge HTTP must bind to a loopback host.");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error(`Invalid Codex Bridge HTTP port: ${options.port}`);
  }
  if (!options.path.startsWith("/")) {
    throw new Error("Codex Bridge HTTP path must start with '/'.");
  }
  if (!options.authToken) {
    throw new Error("Codex Bridge HTTP bearer token is required.");
  }
}

function hasValidBearerToken(header: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return false;
  }
  const actualBuffer = Buffer.from(header.slice(prefix.length), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) {
      throw new Error(`MCP request exceeds ${MAX_REQUEST_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function rpcError(message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
