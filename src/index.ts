#!/usr/bin/env node
import { startStdioProxy } from "./mcp/stdioProxy.js";

startStdioProxy().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
