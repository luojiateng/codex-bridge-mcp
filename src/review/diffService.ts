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
  changedFileCount: number;
  fileOffset: number;
  filesReturned: number;
  hasMoreFiles: boolean;
  patchPath?: string;
  patch?: string;
}

export interface DiffOptions {
  includePatch?: boolean;
  fileOffset?: number;
  fileLimit?: number;
  includeAllFiles?: boolean;
}

export class DiffService {
  constructor(private readonly bridgeConfig: BridgeConfig = config) {}

  async diffTask(task: TaskRecord, options: DiffOptions | boolean = {}): Promise<TaskDiffResult> {
    const normalizedOptions = typeof options === "boolean" ? { includePatch: options } : options;
    const includePatch = normalizedOptions.includePatch ?? false;
    const fileOffset = Math.max(normalizedOptions.fileOffset ?? 0, 0);
    const fileLimit = Math.min(Math.max(normalizedOptions.fileLimit ?? 50, 1), 200);
    const includeAllFiles = normalizedOptions.includeAllFiles ?? false;
    // projectRoot may not be a git repo root itself (git then resolves to an ancestor
    // repo); the "-- ." pathspec keeps every command scoped to projectRoot's own subtree
    // instead of recursing across unrelated sibling directories under that ancestor repo.
    const hasHead = await gitHasHead(task.projectRoot);
    const summary = await trackedDiff(task.projectRoot, hasHead, ["--shortstat", "--", "."]);
    const nameStatus = await trackedDiff(task.projectRoot, hasHead, ["--name-status", "--", "."]);
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
    const summaryLines = [
      summary,
      untrackedFiles.length > 0 ? `${untrackedFiles.length} untracked file(s)` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const fullNameStatus = [
      nameStatus,
      untrackedFiles.map((file) => `A\t${file}`).join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
    const allNameStatus = fullNameStatus.split(/\r?\n/).filter(Boolean);
    const pagedNameStatus = includeAllFiles
      ? allNameStatus
      : allNameStatus.slice(fileOffset, fileOffset + fileLimit);
    const filesReturned = pagedNameStatus.length;
    const hasMoreFiles = !includeAllFiles && fileOffset + filesReturned < allNameStatus.length;
    if (!includePatch) {
      return {
        taskId: task.id,
        projectRoot: task.projectRoot,
        summary: summaryLines,
        nameStatus: pagedNameStatus.join("\n"),
        changedFileCount: allNameStatus.length,
        fileOffset,
        filesReturned,
        hasMoreFiles,
      };
    }

    const patch = [
      await trackedDiff(task.projectRoot, hasHead, ["--patch", "--", "."]),
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
      summary: summaryLines,
      nameStatus: pagedNameStatus.join("\n"),
      changedFileCount: allNameStatus.length,
      fileOffset,
      filesReturned,
      hasMoreFiles,
      patchPath,
      patch,
    };
  }
}

async function trackedDiff(cwd: string, hasHead: boolean, args: string[]): Promise<string> {
  if (hasHead) {
    return git(cwd, ["diff", "HEAD", ...args]);
  }
  return [
    await git(cwd, ["diff", ...args]),
    await git(cwd, ["diff", "--cached", ...args]),
  ]
    .filter(Boolean)
    .join("\n");
}

async function gitHasHead(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    return true;
  } catch {
    return false;
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
