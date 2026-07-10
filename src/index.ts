#!/usr/bin/env node
import { startMcpServer } from "./mcp/server.js";

startMcpServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
