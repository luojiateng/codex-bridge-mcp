import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = path.join(root, "src");

const forbiddenResumeSpawns = [
  /spawn\s*\(\s*["']codex["']\s*,\s*\[[^\]]*["']resume["']/,
  /spawn\s*\(\s*["']codex["']\s*,\s*\[[^\]]*["']exec["'][^\]]*["']resume["']/,
  /codex\s+-resume/i,
  /codex\s+resume/i,
  /codex\s+exec\s+resume/i,
];
const forbiddenTaskSendSpawns = [
  ...forbiddenResumeSpawns,
  /spawn\s*\(/i,
  /execFile\s*\(/i,
  /cmd\.exe/i,
  /powershell(?:\.exe)?/i,
];
const findings = [];

for (const file of walk(src)) {
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of forbiddenResumeSpawns) {
    if (pattern.test(text)) {
      findings.push(`${path.relative(root, file)} matches ${pattern}`);
    }
  }
}

const taskServicePath = path.join(src, "task", "taskService.ts");
const taskServiceText = fs.readFileSync(taskServicePath, "utf8");
const taskSendStart = taskServiceText.indexOf("  async sendTask(");
const taskSendEnd = taskServiceText.indexOf("\n  async waitForAttention(", taskSendStart);
if (taskSendStart < 0 || taskSendEnd < 0) {
  findings.push("src/task/taskService.ts task_send implementation could not be isolated");
}
const taskSendText = taskServiceText.slice(taskSendStart, taskSendEnd);
for (const pattern of forbiddenTaskSendSpawns) {
  if (pattern.test(taskSendText)) {
    findings.push(`${path.relative(root, taskServicePath)} task_send matches ${pattern}`);
  }
}

const tuiManagerPath = path.join(src, "runtime", "tuiWindowManager.ts");
const tuiManagerText = fs.readFileSync(tuiManagerPath, "utf8");
if (!/Start-Process[\s\S]*-WindowStyle Normal[\s\S]*-PassThru/i.test(tuiManagerText)) {
  findings.push("src/runtime/tuiWindowManager.ts must create a visible PowerShell terminal and return its pid");
}

const scriptBuilderPath = path.join(src, "runtime", "powershellScriptBuilder.ts");
const scriptBuilderText = fs.readFileSync(scriptBuilderPath, "utf8");
if (!/while \(\$true\)[\s\S]*retrying in \$retryDelaySeconds/i.test(scriptBuilderText)) {
  findings.push("src/runtime/powershellScriptBuilder.ts must keep the visible session alive until its first rollout is attachable");
}

if (findings.length > 0) {
  console.error("Forbidden Codex resume/runtime spawn patterns found:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("No forbidden Codex resume/runtime spawn patterns found in src/ or task_send.");

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
