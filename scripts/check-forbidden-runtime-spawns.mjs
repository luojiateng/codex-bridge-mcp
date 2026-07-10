import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = path.join(root, "src");

const forbidden = [
  /spawn\s*\(\s*["']codex["']\s*,\s*\[[^\]]*["']resume["']/,
  /spawn\s*\(\s*["']codex["']\s*,\s*\[[^\]]*["']exec["'][^\]]*["']resume["']/,
  /codex\s+-resume/i,
  /codex\s+resume/i,
  /codex\s+exec\s+resume/i,
  /spawn\s*\(\s*["']cmd\.exe["']/i,
];

const allowed = [/codex app-server/];
const findings = [];

for (const file of walk(src)) {
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text) && !allowed.some((ok) => ok.test(text))) {
      findings.push(`${path.relative(root, file)} matches ${pattern}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Forbidden Codex resume/runtime spawn patterns found:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("No forbidden Codex resume/runtime spawn patterns found in src/.");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      yield fullPath;
    }
  }
}
