# Codex Bridge MCP Instructions

- The product name is `Codex Bridge MCP`.
- Claude is the task brain; Codex is the execution engine; this MCP is the reliable session layer.
- `task_send` must never spawn `codex resume`, `codex exec resume`, `cmd.exe`, or `powershell.exe`.
- Runtime startup is allowed only in the Runtime Host Manager, and it may start only `codex app-server`.
- One `projectRoot` maps to one active Runtime Host.
- One `taskId` maps to one `codexThreadId`.
- `thread/start` is only for `task_open`.
- `thread/resume` is only for recovery or when a known thread is not loaded in a reconnected runtime.
- `turn/start` is the only normal path for Claude follow-up instructions.
- Bridge must not auto-approve Codex approval requests.
- Keep changes narrow and preserve the phase plan in `docs/phase-development.md`.
