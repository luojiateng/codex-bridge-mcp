import { delay } from "../runtime/heartbeat.js";
import { createId } from "../shared/id.js";
import {
  canonicalizeProjectRoot,
  type CanonicalProjectRoot,
} from "../shared/projectRoot.js";
import {
  type ProjectSessionRecord,
  type TaskRecord,
  SqliteStore,
} from "../storage/sqlite.js";

const SESSION_CLAIM_LEASE_MS = 120_000;
const SESSION_WAIT_INTERVAL_MS = 50;

export interface ProjectSessionAcquisition {
  outcome: "create" | "reuse";
  canonical: CanonicalProjectRoot;
  session: ProjectSessionRecord;
  claimToken: string | null;
}

export class ProjectSessionCoordinator {
  constructor(private readonly store: SqliteStore) {}

  async acquire(
    projectRoot: string,
    mode: "reuse" | "new",
  ): Promise<ProjectSessionAcquisition> {
    const canonical = canonicalizeProjectRoot(projectRoot);
    const claimToken = createId("session_claim");
    let joinGeneration: number | undefined;
    const deadline = Date.now() + SESSION_CLAIM_LEASE_MS + 5_000;

    while (Date.now() < deadline) {
      const claim = this.store.claimProjectSession({
        projectKey: canonical.projectKey,
        projectRoot: canonical.projectRoot,
        mode,
        claimToken,
        claimExpiresAt: new Date(Date.now() + SESSION_CLAIM_LEASE_MS).toISOString(),
        joinGeneration,
      });
      if (claim.outcome === "create") {
        return {
          outcome: "create",
          canonical,
          session: claim.session,
          claimToken,
        };
      }
      if (claim.outcome === "reuse") {
        return {
          outcome: "reuse",
          canonical,
          session: claim.session,
          claimToken: null,
        };
      }
      joinGeneration = claim.session.generation;
      await delay(SESSION_WAIT_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for project session creation: ${canonical.projectRoot}`);
  }

  complete(
    acquisition: ProjectSessionAcquisition,
    task: TaskRecord,
  ): ProjectSessionRecord {
    if (!acquisition.claimToken) {
      throw new Error(`Cannot complete an unclaimed project session: ${acquisition.session.id}`);
    }
    return this.store.completeProjectSessionClaim({
      sessionId: acquisition.session.id,
      claimToken: acquisition.claimToken,
      task,
    });
  }

  fail(acquisition: ProjectSessionAcquisition): void {
    if (acquisition.claimToken) {
      this.store.failProjectSessionClaim(acquisition.session.id, acquisition.claimToken);
    }
  }
}
