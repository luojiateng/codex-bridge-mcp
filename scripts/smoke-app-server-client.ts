import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexAppServerClient } from "../src/codex/codexAppServerClient.js";
import { buildCodexDeveloperInstructions } from "../src/task/codexInstruction.js";

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(wss, "listening");

const address = wss.address();
assert(address && typeof address === "object");
const endpoint = `ws://127.0.0.1:${address.port}`;

const clientMessages: RpcMessage[] = [];
let activeSocket: WebSocket | null = null;
let connectionCount = 0;
const responseWaiters = new Map<string | number, (message: RpcMessage) => void>();
wss.on("connection", (socket) => {
  connectionCount += 1;
  activeSocket = socket;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8")) as RpcMessage;
    clientMessages.push(message);
    handleClientMessage(socket, message);
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      socket.send(
        JSON.stringify({
          method: "serverRequest/resolved",
          params: { threadId: "thread_mock", requestId: message.id },
        }),
      );
      responseWaiters.get(message.id)?.(message);
      responseWaiters.delete(message.id);
    }
  });
});

const client = new CodexAppServerClient(endpoint);
await Promise.all([client.connect(), client.connect(), client.connect()]);
assert.equal(connectionCount, 1, "Concurrent connect calls must share one App Server WebSocket");
await Promise.all([
  client.ensureThreadReady("thread_existing", process.cwd()),
  client.ensureThreadReady("thread_existing", process.cwd()),
]);
assert.equal(
  clientMessages.filter((message) => message.method === "thread/resume").length,
  1,
  "Concurrent recovery must resume a known thread only once",
);

const threadId = await client.threadStart({
  cwd: process.cwd(),
  developerInstructions: buildCodexDeveloperInstructions(),
});
assert.equal(threadId, "thread_mock");

await client.setThreadName(threadId, "Smoke Thread");

const serverRequestPromise = once(client, "serverRequest");
const turnId = await client.turnStart({
  threadId,
  cwd: process.cwd(),
  text: "Run smoke test turn.",
});
assert.equal(turnId, "turn_mock");

const [serverRequest] = (await serverRequestPromise) as [RpcMessage];
assert.equal(serverRequest.id, "approval-1");
assert.equal(serverRequest.method, "item/commandExecution/requestApproval");

const approvalResponsePromise = waitForClientResponse("approval-1");
await client.decideApproval({
  codexRequestId: "approval-1",
  approvalKind: "item/commandExecution/requestApproval",
  decision: "approve",
  reason: "Smoke test approval.",
  payload: serverRequest.params,
});

const approvalResponse = await approvalResponsePromise;
assert.deepEqual(approvalResponse.result, { decision: "accept" });

sendServerRequest("approval-file", "item/fileChange/requestApproval", {
  threadId,
  turnId,
  grantRoot: process.cwd(),
  reason: "Smoke test file approval.",
});
const [fileRequest] = (await once(client, "serverRequest")) as [RpcMessage];
const fileResponsePromise = waitForClientResponse("approval-file");
await client.decideApproval({
  codexRequestId: "approval-file",
  approvalKind: "item/fileChange/requestApproval",
  decision: "deny",
  reason: "Smoke test denial.",
  payload: fileRequest.params,
});
const fileResponse = await fileResponsePromise;
assert.deepEqual(fileResponse.result, { decision: "decline" });

sendServerRequest("approval-permissions", "item/permissions/requestApproval", {
  threadId,
  turnId,
  permissions: {
    network: { outbound: true },
    fileSystem: { writableRoots: [process.cwd()] },
  },
});
const [permissionsRequest] = (await once(client, "serverRequest")) as [RpcMessage];
const permissionsResponsePromise = waitForClientResponse("approval-permissions");
await client.decideApproval({
  codexRequestId: "approval-permissions",
  approvalKind: "item/permissions/requestApproval",
  decision: "approve",
  reason: "Smoke test permission approval.",
  payload: permissionsRequest.params,
});
const permissionsResponse = await permissionsResponsePromise;
assert.deepEqual(permissionsResponse.result, {
  permissions: {
    network: { outbound: true },
    fileSystem: { writableRoots: [process.cwd()] },
  },
  scope: "turn",
});

sendServerRequest("approval-permissions-deny", "item/permissions/requestApproval", {
  threadId,
  turnId,
  permissions: {
    network: { outbound: true },
  },
});
const [permissionsDenyRequest] = (await once(client, "serverRequest")) as [RpcMessage];
const permissionsDenyResponsePromise = waitForClientResponse("approval-permissions-deny");
await client.decideApproval({
  codexRequestId: "approval-permissions-deny",
  approvalKind: "item/permissions/requestApproval",
  decision: "deny",
  reason: "Smoke test permission denial.",
  payload: permissionsDenyRequest.params,
});
const permissionsDenyResponse = await permissionsDenyResponsePromise;
assert.deepEqual(permissionsDenyResponse.error, {
  code: -32000,
  message: "Smoke test permission denial.",
});

const turnStartRequest = clientMessages.find((message) => message.method === "turn/start");
const threadStartRequest = clientMessages.find((message) => message.method === "thread/start");
assert.equal(
  (turnStartRequest?.params?.input as Array<Record<string, unknown>>)[0]?.text_elements instanceof Array,
  true,
);
assert.equal(turnStartRequest?.params?.approvalsReviewer, "user");
assert.equal("effort" in (turnStartRequest?.params ?? {}), false);
assert.equal("summary" in (turnStartRequest?.params ?? {}), false);
assert.deepEqual(threadStartRequest?.params?.config, {});
assert.match(String(threadStartRequest?.params?.developerInstructions), /Keep execution minimal/);
assert.match(String(threadStartRequest?.params?.developerInstructions), /task orchestrator/);
assert.match(String(threadStartRequest?.params?.developerInstructions), /Keep tool output economical/);
assert.match(String(threadStartRequest?.params?.developerInstructions), /End every turn with one concise final message/);
assert.doesNotMatch(String(threadStartRequest?.params?.developerInstructions), /JSON self-report|report\.json/);
assert.equal(clientMessages.filter((message) => message.method === "thread/resume").length, 1);

client.drop();
await new Promise<void>((resolve) => wss.close(() => resolve()));
console.log("Codex App Server client smoke test passed.");

function handleClientMessage(socket: WebSocket, message: RpcMessage): void {
  if (!message.id || !message.method) {
    return;
  }

  switch (message.method) {
    case "initialize":
      respond(socket, message.id, {
        userAgent: "codex-bridge-mcp-smoke",
        codexHome: process.cwd(),
        platformFamily: "windows",
        platformOs: "windows",
      });
      return;
    case "thread/start":
      respond(socket, message.id, { thread: { id: "thread_mock" } });
      return;
    case "thread/name/set":
      respond(socket, message.id, {});
      return;
    case "thread/resume":
      respond(socket, message.id, { thread: { id: "thread_mock" } });
      return;
    case "thread/compact/start":
      respond(socket, message.id, {});
      return;
    case "turn/start":
      respond(socket, message.id, { turn: { id: "turn_mock" } });
      queueMicrotask(() => {
        socket.send(
          JSON.stringify({
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "thread_mock",
              turnId: "turn_mock",
              itemId: "item_mock",
              startedAtMs: Date.now(),
              environmentId: null,
              command: "npm test",
              cwd: process.cwd(),
              reason: "Smoke test command approval.",
            },
          }),
        );
      });
      return;
    default:
      respond(socket, message.id, {});
  }
}

function respond(socket: WebSocket, id: string | number, result: unknown): void {
  socket.send(JSON.stringify({ id, result }));
}

function sendServerRequest(
  id: string,
  method: string,
  params: Record<string, unknown>,
): void {
  assert(activeSocket);
  activeSocket.send(JSON.stringify({ id, method, params }));
}

function waitForClientResponse(id: string | number): Promise<RpcMessage> {
  return new Promise((resolve) => {
    responseWaiters.set(id, resolve);
  });
}
