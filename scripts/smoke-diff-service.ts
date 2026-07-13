import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DiffService } from "../src/review/diffService.js";
import type { TaskRecord } from "../src/storage/sqlite.js";

const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-diff-"));
runGit(["init"]);
runGit(["config", "user.email", "smoke@example.com"]);
runGit(["config", "user.name", "Codex Bridge Smoke"]);
await fs.writeFile(path.join(projectRoot, "tracked.txt"), "before\n", "utf8");
runGit(["add", "tracked.txt"]);
runGit(["commit", "-m", "initial fixture"]);

await fs.writeFile(path.join(projectRoot, "tracked.txt"), "staged change\n", "utf8");
runGit(["add", "tracked.txt"]);
await fs.writeFile(path.join(projectRoot, "untracked.txt"), "untracked change\n", "utf8");
await fs.writeFile(path.join(projectRoot, "untracked-second.txt"), "another untracked change\n", "utf8");

const task: TaskRecord = {
  id: "task_diff_smoke",
  title: "Diff Smoke",
  projectRoot,
  runtimeHostId: "runtime_diff_smoke",
  codexThreadId: "thread_diff_smoke",
  codexThreadName: "Diff Smoke",
  status: "waiting_review",
  requirements: null,
  acceptanceCriteria: [],
  tokenBudget: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};
const service = new DiffService({ logsDir: path.join(projectRoot, "logs") } as never);
const firstPage = await service.diffTask(task, { fileLimit: 1 });
assert.equal(firstPage.changedFileCount, 3);
assert.equal(firstPage.filesReturned, 1);
assert.equal(firstPage.hasMoreFiles, true);

const result = await service.diffTask(
  task,
  { includePatch: true, includeAllFiles: true },
);

assert.match(result.summary, /file changed/);
assert.match(result.summary, /2 untracked file\(s\)/);
assert.match(result.nameStatus, /tracked\.txt/);
assert.match(result.nameStatus, /untracked\.txt/);
assert.equal(result.changedFileCount, 3);
assert.equal(result.hasMoreFiles, false);
assert.match(result.patch ?? "", /staged change/);
assert.match(result.patch ?? "", /untracked change/);

console.log("Diff smoke test passed.");

function runGit(args: string[]): void {
  execFileSync("git", args, { cwd: projectRoot, stdio: "pipe" });
}
