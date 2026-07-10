import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const entrypoint = path.join(projectRoot, "dist", "index.js");
await fs.access(entrypoint);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-mcp-stdio-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint],
  cwd: projectRoot,
  env: {
    ...stringEnv(),
    CODEX_BRIDGE_DATA_DIR: path.join(tempDir, "data"),
  },
  stderr: "pipe",
});

const client = new Client(
  {
    name: "codex-bridge-mcp-stdio-smoke",
    version: "0.1.0",
  },
  {
    capabilities: {},
  },
);

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "approval_decide",
    "task_compact",
    "task_diff",
    "task_events",
    "task_list",
    "task_open",
    "task_recover",
    "task_send",
    "task_status",
  ]);
  assert.match(client.getInstructions() ?? "", /task_open once/);
  console.log("MCP stdio smoke test passed.");
} finally {
  await client.close();
}

function stringEnv(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}
