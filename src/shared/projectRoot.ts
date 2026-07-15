import fs from "node:fs";
import path from "node:path";

export interface CanonicalProjectRoot {
  projectRoot: string;
  projectKey: string;
}

export function canonicalizeProjectRoot(input: string): CanonicalProjectRoot {
  const resolved = path.resolve(input);
  let realPath = resolved;
  try {
    realPath = fs.realpathSync.native(resolved);
  } catch {
    // The Runtime Host will report the missing or inaccessible project later.
  }
  const projectRoot = trimTrailingSeparators(path.normalize(realPath));
  return {
    projectRoot,
    projectKey: process.platform === "win32" ? projectRoot.toLocaleLowerCase("en-US") : projectRoot,
  };
}

function trimTrailingSeparators(value: string): string {
  const root = path.parse(value).root;
  if (value === root) {
    return value;
  }
  return value.replace(/[\\/]+$/, "");
}
