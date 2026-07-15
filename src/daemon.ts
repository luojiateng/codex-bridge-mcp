#!/usr/bin/env node
import { config } from "./config/config.js";
import { BridgeCore } from "./core/bridgeCore.js";
import {
  BridgeHttpServer,
  loadOrCreateMcpToken,
  resolveBridgeHttpAddress,
} from "./mcp/httpServer.js";

async function main(): Promise<void> {
  const { token, tokenPath, source } = await loadOrCreateMcpToken(config.dataDir);
  const server = new BridgeHttpServer(new BridgeCore(config), {
    ...resolveBridgeHttpAddress(),
    authToken: token,
  });
  await server.start();
  console.error(`Codex Bridge Core ready at ${server.endpoint}`);
  console.error(
    source === "environment"
      ? "MCP bearer token source: CODEX_BRIDGE_MCP_TOKEN"
      : `MCP bearer token source: ${tokenPath}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`Codex Bridge Core received ${signal}; draining.`);
    await server.stop();
  };
  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
