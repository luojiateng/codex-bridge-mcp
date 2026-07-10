import net from "node:net";
import { shortHash } from "../shared/id.js";

export async function allocateStablePort(
  projectRoot: string,
  base: number,
  span: number,
): Promise<number> {
  const offset = Number.parseInt(shortHash(projectRoot, 8), 16) % span;
  for (let i = 0; i < span; i += 1) {
    const port = base + ((offset + i) % span);
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free Codex Runtime Host port in range ${base}-${base + span - 1}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
