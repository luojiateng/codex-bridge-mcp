# Codex Bridge MCP

Codex Bridge MCP is a local MCP orchestration service for a stable Claude Code x Codex CLI development workflow.

The core promise is simple:

```text
Claude Code -> Codex Bridge MCP -> one long-lived Codex Runtime Host
            -> one Codex App Server process -> one Codex Thread -> continuous turn/start
```

This project intentionally does **not** use `codex resume` or `codex exec resume` in the main flow. Those commands start new CLI processes. The bridge starts `codex app-server` once per project runtime, then sends follow-up instructions through the App Server protocol.

## Phase-1 Scope In This Skeleton

- MCP tool surface with 9 tools:
  - `task_open`
  - `task_send`
  - `task_status`
  - `task_events`
  - `task_diff`
  - `approval_decide`
  - `task_compact`
  - `task_recover`
  - `task_list`
- SQLite-backed runtime, task, turn, event, approval, and queue records.
- JSONL audit logs under `data/logs/`.
- Runtime Host Manager that can start one visible PowerShell Runtime Host per `projectRoot`.
- WebSocket JSON-RPC client for `codex app-server`.
- Hard guardrails that keep `task_send` on `turn/start`.

## Local Commands

```powershell
npm install
npm run generate:codex-types
npm run typecheck
npm run build
npm run check:forbidden
npm run smoke:protocol
npm run smoke:context
npm run smoke:queue
npm run smoke:recovery
npm run smoke:mcp
```

`npm run e2e:real` performs the real Runtime Host acceptance test. It starts or reuses a visible PowerShell Runtime Host and a real `codex app-server`, so run it only when a long-lived local Codex process is acceptable.

Starting this MCP in Claude/Codex requires a normal stdio MCP configuration after dependencies are installed:

```toml
[mcp_servers.codex_bridge]
command = "node"
args = ["E:\\workspace\\dianyi\\codex-bridge-mcp\\dist\\index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 600
```

## Runtime Boundary

The bridge starts a PowerShell Runtime Host window only when a Runtime Host is missing or dead. That window runs:

```powershell
codex app-server --listen ws://127.0.0.1:<port>
```

This window is pure process plumbing, not a place Claude or Codex ever converse -- all of its startup output is already captured to `data/logs/runtime/*.host.log`, `.host.stdout.log`, and `.host.stderr.log`, so it defaults to hidden (`runtimeHostWindow: "hidden"`, overridable with `CODEX_BRIDGE_RUNTIME_HOST_WINDOW=visible`). The actual visible, conversational window a human should watch is the Codex TUI described below.

After the Runtime Host is up, all Claude follow-up work uses `turn/start` through the existing WebSocket endpoint.

Runtime startup uses a short PowerShell launcher with `Start-Process -PassThru`; the long-lived process then runs the generated runtime script. Host stdout/stderr is written to `data/logs/runtime/*.host.log` next to the JSONL runtime audit log.

The generated host script resolves `codex.cmd` on Windows and runs the App Server with stdout/stderr redirected to sibling `.host.stdout.log` and `.host.stderr.log` files. This avoids PowerShell 5 rendering Codex's normal startup banner as a misleading `NativeCommandError` in the Runtime Host window.

## Protocol Types

The app-server protocol types are generated from the installed local Codex CLI:

```powershell
npm run generate:codex-types
```

The generator output is normalized for Node ESM imports by `scripts/fix-generated-imports.mjs`. The bridge uses these generated types for `initialize`, `thread/start`, `thread/resume`, `thread/name/set`, `thread/compact/start`, `turn/start`, server notifications, and server-initiated approval requests.

`npm run smoke:protocol` uses a short-lived local mock WebSocket server. It does not start a real Codex Runtime Host.

## Context Governance

The bridge listens for `thread/tokenUsage/updated` notifications and stores a compact token snapshot per task. `task_status` reports the latest context usage, surfaces a warning at 70%, and points Claude to `task_compact` at 85%. The 85% threshold also emits one `context_near_limit` event so Claude can compact without replaying full logs into context.

`npm run smoke:context` validates this flow against an in-process notification fixture. It does not start a real Codex Runtime Host.

## Codex Model And Display

By default the bridge does not override Codex model, reasoning effort, reasoning summary, verbosity, or service tier. It inherits the user's current Codex configuration, so a local Codex setup that shows `Model: gpt-5.5 xhigh` stays on that setting.

Optional overrides are still available when needed:

- `CODEX_BRIDGE_CODEX_MODEL`
- `CODEX_BRIDGE_CODEX_EFFORT`
- `CODEX_BRIDGE_CODEX_SUMMARY`
- `CODEX_BRIDGE_CODEX_VERBOSITY`
- `CODEX_BRIDGE_CODEX_SERVICE_TIER`

The bridge can also open a visible Codex remote TUI window for each opened task thread:

- `CODEX_BRIDGE_CODEX_TUI_MODE=resume` opens `codex resume --remote <endpoint> <threadId>` in a PowerShell window. This is the default and attaches the TUI to the task thread.
- `CODEX_BRIDGE_CODEX_TUI_MODE=remote` opens `codex --remote <endpoint>` without attaching a specific thread.
- `CODEX_BRIDGE_CODEX_TUI_MODE=off` disables the extra TUI window.

The TUI window is only for visibility and manual interaction. Claude follow-up instructions still go through App Server `turn/start`; `task_send` does not spawn Codex CLI processes.

## Token Control

`task_send` also accepts `runChecks`. It defaults to `false`, so simple deterministic edits do not ask Codex to run verification commands such as `Get-Content` after every change. Set `runChecks: true` when Claude wants Codex to run the most relevant lightweight check.

## Event And Queue Recovery

`task_events` returns short event summaries by default. Full payloads are still persisted in SQLite and JSONL, and can be requested with `includePayload: true` for debugging.

Queued commands are persisted before execution. If Bridge restarts while a command is marked `running`, the next TaskService startup marks it `interrupted`, emits a `task_command_interrupted` event, and exposes queue counts in `task_status`. It does not replay an already-started command automatically, avoiding duplicate code edits.

`npm run smoke:queue` validates interrupted queue recovery. `npm run smoke:recovery` validates Bridge restart recovery against an already-alive App Server endpoint without starting a new Runtime Host.

## MCP Stdio

`npm run smoke:mcp` starts the built MCP over stdio, lists tools through the official MCP SDK client, and verifies the 9-tool surface. Run `npm run build` first; build copies `src/storage/schema.sql` into `dist/storage/schema.sql` so the compiled MCP can initialize SQLite.

## Real E2E

`npm run e2e:real` creates a fixture project under `E:\tmp\codex-bridge-mcp-real-e2e` by default. It opens one task, sends two `task_send` turns, and verifies:

- the same `runtimeHostId` and endpoint are reused;
- both turns use the same `codexThreadId`;
- `notes.txt` receives both requested lines;
- `task_diff` reports the expected working-tree change.

The E2E harness simulates Claude for approvals. It approves only fixture-local file changes and simple fixture-local commands, while the Bridge itself still never auto-approves approval requests.
