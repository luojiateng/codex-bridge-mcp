import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { terminateOwnedProcess } from "../src/runtime/tuiWindowManager.js";

if (process.platform !== "win32") {
  console.log("TUI process-tree smoke test skipped outside Windows.");
  process.exit(0);
}

const childCode = "setInterval(() => {}, 1000);";
const parentCode = [
  'const { spawn } = require("node:child_process");',
  `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { windowsHide: true, stdio: "ignore" });`,
  'process.stdout.write(String(child.pid) + "\\n");',
  "setInterval(() => {}, 1000);",
].join("\n");
const parent = spawn(process.execPath, ["-e", parentCode], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
assert(parent.pid);

const [chunk] = (await once(parent.stdout, "data")) as [Buffer];
const childPid = Number.parseInt(chunk.toString("utf8").trim(), 10);
assert(Number.isFinite(childPid));

let skippedReason: string | null = null;
try {
  assert.equal(isAlive(parent.pid), true);
  assert.equal(isAlive(childPid), true);
  try {
    terminateOwnedProcess(parent.pid);
    await waitUntilExited(parent.pid, childPid);
    assert.equal(isAlive(parent.pid), false);
    assert.equal(isAlive(childPid), false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const restrictedSandboxFailure =
      Boolean(process.env.CODEX_PERMISSION_PROFILE) &&
      message.includes("taskkillStatus=1") &&
      isAlive(parent.pid);
    if (!restrictedSandboxFailure) {
      throw error;
    }
    skippedReason = message;
  }
} finally {
  terminateIfAlive(parent.pid);
  terminateIfAlive(childPid);
}

console.log(
  skippedReason
    ? `TUI process-tree smoke test skipped: ${skippedReason}`
    : "TUI process-tree smoke test passed.",
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilExited(...pids: number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pids.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function terminateIfAlive(pid: number): void {
  if (!isAlive(pid)) {
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // The test process may have exited between the liveness check and termination.
  }
}
