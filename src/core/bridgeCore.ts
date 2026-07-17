import { CodexClientPool } from "../codex/codexAppServerClient.js";
import { config, type BridgeConfig } from "../config/config.js";
import { DiffService } from "../review/diffService.js";
import { RuntimeHostManager } from "../runtime/runtimeHostManager.js";
import { TuiWindowManager } from "../runtime/tuiWindowManager.js";
import { JsonlLogger } from "../storage/jsonlLogger.js";
import { type CoreUpgradeBlockers, SqliteStore } from "../storage/sqlite.js";
import { CompactService } from "../task/compactService.js";
import { ProjectSessionCoordinator } from "../task/projectSessionCoordinator.js";
import { RecoveryService } from "../task/recoveryService.js";
import { TaskService } from "../task/taskService.js";

export type BridgeCoreState =
  | "STARTING"
  | "RECONCILING"
  | "READY"
  | "DRAINING"
  | "STOPPED";

export interface BridgeCoreServices {
  taskService: TaskService;
  compactService: CompactService;
  recoveryService: RecoveryService;
}

export interface CoreUpgradeReadiness {
  safe: boolean;
  state: BridgeCoreState;
  blockers: CoreUpgradeBlockers;
}

/**
 * The single lifecycle owner for all stateful Bridge components.
 * MCP transports are intentionally not owned here: clients may reconnect without
 * recreating Runtime/App Server connections or replaying startup recovery.
 */
export class BridgeCore {
  private currentState: BridgeCoreState = "STOPPED";
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private store: SqliteStore | null = null;
  private clientPool: CodexClientPool | null = null;
  private taskService: TaskService | null = null;
  private compactService: CompactService | null = null;
  private recoveryService: RecoveryService | null = null;

  constructor(private readonly bridgeConfig: BridgeConfig = config) {}

  get state(): BridgeCoreState {
    return this.currentState;
  }

  get services(): BridgeCoreServices {
    if (
      this.currentState !== "READY" ||
      !this.taskService ||
      !this.compactService ||
      !this.recoveryService
    ) {
      throw new Error(`Bridge Core is not ready: ${this.currentState}`);
    }
    return {
      taskService: this.taskService,
      compactService: this.compactService,
      recoveryService: this.recoveryService,
    };
  }

  getUpgradeReadiness(): CoreUpgradeReadiness {
    const blockers = this.store?.getCoreUpgradeBlockers() ?? {
      activeTurns: 0,
      runningCommands: 0,
      queuedCommands: 0,
      activeApprovals: 0,
      transitionalProjectSessions: 0,
      transitionalRuntimes: 0,
    };
    return {
      safe:
        this.currentState === "READY" &&
        Object.values(blockers).every((count) => count === 0),
      state: this.currentState,
      blockers,
    };
  }

  beginUpgrade(): CoreUpgradeReadiness {
    const readiness = this.getUpgradeReadiness();
    if (readiness.safe) {
      // Reserve lifecycle ownership synchronously so no new MCP request can
      // start work between the blocker check and the deferred HTTP shutdown.
      this.currentState = "DRAINING";
    }
    return readiness;
  }

  start(): Promise<void> {
    if (this.currentState === "READY") {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.currentState === "DRAINING") {
      throw new Error("Bridge Core cannot start while it is draining.");
    }

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.currentState === "STOPPED" && !this.startPromise) {
      return Promise.resolve();
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async startInternal(): Promise<void> {
    this.currentState = "STARTING";
    try {
      const store = new SqliteStore(this.bridgeConfig.dbPath);
      this.store = store;
      const logger = new JsonlLogger(this.bridgeConfig.logsDir);
      const clientPool = new CodexClientPool(this.bridgeConfig);
      this.clientPool = clientPool;
      const tuiWindowManager = new TuiWindowManager(store, this.bridgeConfig);
      const projectSessions = new ProjectSessionCoordinator(store);
      const runtimeHostManager = new RuntimeHostManager(
        store,
        logger,
        clientPool,
        this.bridgeConfig,
        tuiWindowManager,
      );
      const diffService = new DiffService(this.bridgeConfig);
      const taskService = new TaskService(
        store,
        runtimeHostManager,
        clientPool,
        logger,
        diffService,
        this.bridgeConfig,
        projectSessions,
        tuiWindowManager,
      );
      const compactService = new CompactService(store, runtimeHostManager, clientPool, logger);
      const recoveryService = new RecoveryService(
        store,
        runtimeHostManager,
        clientPool,
        logger,
        this.bridgeConfig,
        (task, runtime, client) => taskService.bindTaskRuntimeEvents(task, runtime, client),
        tuiWindowManager,
      );

      this.taskService = taskService;
      this.compactService = compactService;
      this.recoveryService = recoveryService;

      this.currentState = "RECONCILING";
      await taskService.start();
      this.currentState = "READY";
    } catch (error) {
      this.releaseResources();
      this.currentState = "STOPPED";
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    if (this.currentState === "STOPPED") {
      return;
    }
    this.currentState = "DRAINING";
    this.releaseResources();
    this.currentState = "STOPPED";
  }

  private releaseResources(): void {
    this.taskService?.stop();
    this.clientPool?.closeAll();
    this.store?.close();
    this.taskService = null;
    this.compactService = null;
    this.recoveryService = null;
    this.clientPool = null;
    this.store = null;
  }
}
