export async function isHttpReady(endpoint: string, timeoutMs: number): Promise<boolean> {
  const readyUrl = `${endpoint.replace(/^ws:/, "http:").replace(/^wss:/, "https:")}/readyz`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(readyUrl, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForHttpReady(endpoint: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHttpReady(endpoint, 1_000)) {
      return;
    }
    await delay(500);
  }
  throw new Error(`Codex App Server did not become ready: ${endpoint}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
