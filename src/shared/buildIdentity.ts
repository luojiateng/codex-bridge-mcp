import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const BRIDGE_PROTOCOL_VERSION = 2;
export const BRIDGE_BUILD_ID = readBuildId();

function readBuildId(): string {
  const override = process.env.CODEX_BRIDGE_BUILD_ID_OVERRIDE?.trim();
  if (override) {
    return override;
  }
  const candidates = [
    new URL("../build-id.txt", import.meta.url),
    new URL("../../dist/build-id.txt", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const value = fs.readFileSync(fileURLToPath(candidate), "utf8").trim();
      if (value) {
        return value;
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }
  return "development";
}
