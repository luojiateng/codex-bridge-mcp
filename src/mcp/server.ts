import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CodexClientPool } from "../codex/codexAppServerClient.js";
import { config } from "../config/config.js";
import { RuntimeHostManager } from "../runtime/runtimeHostManager.js";
import { DiffService } from "../review/diffService.js";
import { JsonlLogger } from "../storage/jsonlLogger.js";
import { SqliteStore } from "../storage/sqlite.js";
import { CompactService } from "../task/compactService.js";
import { RecoveryService } from "../task/recoveryService.js";
import { TaskService } from "../task/taskService.js";
import { registerTools } from "./tools.js";

const instructions = [
  "Codex Bridge MCP keeps Claude Code connected to one long-lived Codex Runtime Host.",
  "Use task_open once for a new requirement.",
  "Use task_send for every follow-up instruction on the same taskId.",
  "Do not ask this bridge to use CLI resume commands.",
  "Approval requests must be handled by Claude through approval_decide.",
  "After codex_turn_completed, call task_diff before accepting the work.",
].join("\n");

export async function startMcpServer(): Promise<void> {
  const store = new SqliteStore(config.dbPath);
  const logger = new JsonlLogger(config.logsDir);
  const clientPool = new CodexClientPool(config);
  const runtimeHostManager = new RuntimeHostManager(store, logger, clientPool, config);
  const diffService = new DiffService(config);
  const taskService = new TaskService(
    store,
    runtimeHostManager,
    clientPool,
    logger,
    diffService,
    config,
  );
  const compactService = new CompactService(store, runtimeHostManager, clientPool, logger);
  const recoveryService = new RecoveryService(
    store,
    runtimeHostManager,
    clientPool,
    logger,
    config,
    (task, runtime, client) => taskService.bindTaskRuntimeEvents(task, runtime, client),
  );

  const server = new McpServer(
    {
      name: "codex-bridge-mcp",
      version: "0.1.0",
    },
    {
      instructions,
    },
  );

  await taskService.waitForStartupRecovery();
  registerTools(server, taskService, compactService, recoveryService);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", () => {
    store.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    store.close();
    process.exit(0);
  });
}
