import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../src/config/config.js";
import { BridgeCore } from "../src/core/bridgeCore.js";
import { BridgeHttpServer } from "../src/mcp/httpServer.js";
import { BRIDGE_BUILD_ID, BRIDGE_PROTOCOL_VERSION } from "../src/shared/buildIdentity.js";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-mcp-http-"));
const token = "http-smoke-token";
const bridgeConfig = {
  ...config,
  dataDir: tempDir,
  dbPath: path.join(tempDir, "bridge.db"),
  logsDir: path.join(tempDir, "logs"),
  runtimeScriptsDir: path.join(tempDir, "runtime-scripts"),
  codexTuiMode: "off" as const,
};
const core = new BridgeCore(bridgeConfig);
const server = new BridgeHttpServer(core, {
  host: "127.0.0.1",
  port: 0,
  path: "/mcp",
  authToken: token,
});
await server.start();
assert.equal((await fetch(server.endpoint, { method: "POST" })).status, 401);
const healthResponse = await fetch(new URL("/healthz", server.endpoint));
assert.equal(healthResponse.status, 200);
const health = (await healthResponse.json()) as {
  protocolVersion: number;
  buildId: string;
};
assert.equal(health.protocolVersion, BRIDGE_PROTOCOL_VERSION);
assert.equal(health.buildId, BRIDGE_BUILD_ID);

const first = createClient("first");
const second = createClient("second");
try {
  await Promise.all([first.connect(createTransport()), second.connect(createTransport())]);
  const [firstTools, secondTools] = await Promise.all([first.listTools(), second.listTools()]);
  const expected = [
    "approval_decide",
    "task_await",
    "task_compact",
    "task_diff",
    "task_events",
    "task_list",
    "task_open",
    "task_recover",
    "task_send",
    "task_status",
  ];
  assert.deepEqual(firstTools.tools.map((tool) => tool.name).sort(), expected);
  assert.deepEqual(secondTools.tools.map((tool) => tool.name).sort(), expected);
  assert.equal(core.state, "READY");
  assert.match(first.getInstructions() ?? "", /durable active session/);

  await first.close();
  assert.equal(core.state, "READY", "MCP client disconnect must not stop the Bridge Core");
  assert.equal((await second.listTools()).tools.length, expected.length);

  const duplicateCore = new BridgeCore({
    ...bridgeConfig,
    dbPath: path.join(tempDir, "duplicate.db"),
  });
  const duplicate = new BridgeHttpServer(duplicateCore, {
    host: "127.0.0.1",
    port: Number(new URL(server.endpoint).port),
    path: "/mcp",
    authToken: token,
  });
  await assert.rejects(duplicate.start(), /EADDRINUSE/);
  assert.equal(duplicateCore.state, "STOPPED");
} finally {
  await first.close().catch(() => undefined);
  await second.close().catch(() => undefined);
  await server.stop();
}

assert.equal(core.state, "STOPPED");
console.log("MCP Streamable HTTP multi-client lifecycle smoke test passed.");

function createClient(suffix: string): Client {
  return new Client(
    { name: `codex-bridge-http-smoke-${suffix}`, version: "0.1.0" },
    { capabilities: {} },
  );
}

function createTransport(): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(server.endpoint), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}
