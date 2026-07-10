import crypto from "node:crypto";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function shortHash(input: string, length = 10): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length);
}

export function slugify(input: string, fallback = "task"): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || fallback;
}

export function createRuntimeId(projectRoot: string, port: number): string {
  const base = path.basename(projectRoot) || "project";
  return `runtime-${slugify(base, "project")}-${port}-${shortHash(projectRoot, 6)}`;
}

export function createTaskId(projectRoot: string, title: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const project = slugify(path.basename(projectRoot) || "project", "project");
  const name = slugify(title, "task").slice(0, 48);
  return `${project}-${name}-${date}-${shortHash(`${projectRoot}:${title}:${Date.now()}`, 6)}`;
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
