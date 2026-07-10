import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, type BridgeConfig } from "../config/config.js";
import { slugify } from "../shared/id.js";
import type { TaskRecord } from "../storage/sqlite.js";

const execFileAsync = promisify(execFile);

export interface TaskDiffResult {
  taskId: string;
  projectRoot: string;
  summary: string;
  nameStatus: string;
  patchPath?: string;
  patch?: string;
}

export class DiffService {
  constructor(private readonly bridgeConfig: BridgeConfig = config) {}

  async diffTask(task: TaskRecord, includePatch = false): Promise<TaskDiffResult> {
    // projectRoot may not be a git repo root itself (git then resolves to an ancestor
    // repo); the "-- ." pathspec keeps every command scoped to projectRoot's own subtree
    // instead of recursing across unrelated sibling directories under that ancestor repo.
    const summary = await git(task.projectRoot, ["diff", "--stat", "--", "."]);
    const nameStatus = await git(task.projectRoot, ["diff", "--name-status", "--", "."]);
    const status = await git(task.projectRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
    ]);
    const untrackedFiles = status
      .split(/\r?\n/)
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3));
    const fullSummary = [
      summary,
      untrackedFiles.map((file) => `${file} | new file`).join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
    const fullNameStatus = [
      nameStatus,
      untrackedFiles.map((file) => `A\t${file}`).join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
    if (!includePatch) {
      return {
        taskId: task.id,
        projectRoot: task.projectRoot,
        summary: fullSummary,
        nameStatus: fullNameStatus,
      };
    }

    const patch = [
      await git(task.projectRoot, ["diff", "--patch", "--", "."]),
      (
        await Promise.all(
          untrackedFiles.map((file) => gitNoIndexPatch(task.projectRoot, file)),
        )
      )
        .filter(Boolean)
        .join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
    const dir = path.join(this.bridgeConfig.logsDir, "tasks");
    await fs.mkdir(dir, { recursive: true });
    const patchPath = path.join(dir, `${slugify(task.id)}.diff`);
    await fs.writeFile(patchPath, patch, "utf8");
    return {
      taskId: task.id,
      projectRoot: task.projectRoot,
      summary: fullSummary,
      nameStatus: fullNameStatus,
      patchPath,
      patch,
    };
  }
}

async function gitNoIndexPatch(cwd: string, file: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["diff", "--no-index", "--", "/dev/null", file],
      {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    return stdout.trim() || stderr.trim();
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    if (err.code === 1) {
      return [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    }
    return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout.trim() || stderr.trim();
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
  }
}
