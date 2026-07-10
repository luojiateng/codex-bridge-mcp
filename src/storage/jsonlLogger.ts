import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../shared/id.js";

export class JsonlLogger {
  constructor(private readonly logsDir: string) {}

  async append(scope: "runtime" | "tasks" | "approvals", name: string, payload: unknown): Promise<void> {
    const dir = path.join(this.logsDir, scope);
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      ts: nowIso(),
      ...asObject(payload),
    });
    await fs.appendFile(path.join(dir, `${sanitizeFileName(name)}.jsonl`), `${line}\n`, "utf8");
  }
}

function asObject(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { payload };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 160);
}
