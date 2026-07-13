# Codex Bridge MCP

> 让 Claude 把事情想清楚，让 Codex 在同一个任务里持续把活干完。

Claude Code 擅长和你讨论需求、拆解问题、做判断；Codex 擅长进入仓库、修改代码、运行命令和验证结果。

让它们合作一次并不难。真正麻烦的是：一项复杂开发任务往往要经历多轮补充、审批、验证、返工，甚至中途重启。如果每条指令都临时拉起一个新的 Codex 进程，会话上下文、任务进度和执行状态很快就散了。

**Codex Bridge MCP** 是运行在本机的 MCP 服务，放在 Claude Code 和 Codex App Server 之间。它不替 Claude 思考，也不替 Codex 写代码；它负责把任务、运行时、线程、审批、事件和结果可靠地接在一起，让一次开发任务可以连续执行、随时查看、出错恢复，最后还能回到 Claude 这里做验收。

## 为什么会有这个项目

很多“Claude 调 Codex”的方案只解决了第一步：发出一条指令。真实开发中更难的是后面的事情：

- 需求补充了三次，Codex 还记不记得前面的约束？
- 同一个项目会不会越开越多 App Server 和终端窗口？
- Codex 请求执行高风险命令时，谁来决定是否批准？
- Claude、Bridge 或电脑重启以后，原任务还能不能找回来？
- 任务做得很长，怎样知道上下文快满了，什么时候应该压缩？
- Codex 说“完成了”，Claude 怎样拿到真实 diff，而不是只听结果描述？
- 日志和事件需要保留，但怎样避免每次都把完整历史重新塞进模型上下文？

Codex Bridge MCP 把这些问题视为同一件事：**一项开发任务需要一条有状态、可恢复、可审阅的执行链，而不只是一次工具调用。**

## 三者怎样分工

```text
你
│  提需求、做最终决定
▼
Claude Code
│  理解需求、拆解任务、处理审批、审查结果
│  MCP
▼
Codex Bridge MCP
│  绑定任务与线程、维护 Runtime、保存状态、转发事件
│  WebSocket JSON-RPC
▼
Codex App Server / Codex CLI
   修改代码、运行命令、执行验证
```

- **Claude 是任务大脑**：负责和你沟通、明确边界、组织后续指令、决定审批并验收结果。
- **Codex 是执行引擎**：负责进入真实仓库完成修改和验证。
- **Bridge 是可靠会话层**：负责让 Claude 的后续要求始终落到正确的 Codex 任务、运行时和线程上。

它不是新的模型，也不是云端代理服务，更不会替 Claude 自动批准 Codex 的高风险操作。

## 它解决了什么

### 1. 多轮任务不会每次从头开始

一个任务通过 `task_open` 创建后，会绑定一个稳定的 `taskId` 和 `codexThreadId`。后续要求统一通过 `task_send` 进入同一个线程的 `turn/start`，Codex 可以继续使用前面已经形成的上下文。

### 2. 同一个项目复用同一个 Runtime

一个 `projectRoot` 最多对应一个活跃 Runtime Host。Bridge 会复用已有的 `codex app-server`，而不是每次补充需求都重新启动一套执行环境。

### 3. 审批权仍然在 Claude 和用户手里

Codex 发起命令或文件修改审批时，Bridge 会保存请求并将它暴露给 Claude。Claude 必须通过 `approval_decide` 明确批准或拒绝，并给出原因。Bridge 自身不会自动放行。

### 4. 进度、事件和结果都能追踪

任务状态、轮次、事件、审批、队列和上下文用量会写入 SQLite；关键运行过程同时写入 JSONL。Claude 可以获取简短状态和增量事件，需要排查时再显式请求完整 payload。

### 5. 中断以后可以恢复

Bridge 重启时会优先重连仍然存活的 App Server。已知线程未加载，或 Runtime 在电脑重启后需要重建时，恢复链路才会使用 `thread/resume`。已经开始但被中断的队列任务会被标记出来，不会被静默重复执行。

### 6. 长任务有上下文治理

Bridge 会记录 App Server 上报的 token 用量：

- 上下文达到约 70% 时，`task_status` 给出提醒；
- 达到约 85% 时，产生一次 `context_near_limit` 事件；
- Claude 可以调用 `task_compact` 压缩原线程，而不是把全部历史重新发送一遍。

### 7. “执行完成”之后还有审查闭环

Codex turn 完成后，Bridge 会提示下一步调用 `task_diff`。Claude 根据真实工作区 diff 对照需求和验收标准；如果还不完整，就继续发送 `task_send`，而不是把 Codex 的完成声明直接当成验收结果。

## 一项任务实际怎样流转

你通常不需要手工背这些工具名。正常情况下，Claude 会按下面的链路调用它们：

| 阶段 | 工具 | 发生的事情 |
| --- | --- | --- |
| 创建任务 | `task_open` | 建立任务，启动或复用 Runtime，创建并绑定 Codex 线程 |
| 继续执行 | `task_send` | 把补充要求送入同一线程的下一次 `turn/start` |
| 查看进度 | `task_status` / `task_events` | 获取运行状态、增量事件、审批和上下文提醒 |
| 处理风险 | `approval_decide` | 由 Claude 明确批准或拒绝 Codex 的审批请求 |
| 审查结果 | `task_diff` | 获取工作区变更摘要，按需包含 patch |
| 控制上下文 | `task_compact` | 在原线程上启动上下文压缩 |
| 恢复任务 | `task_recover` | 重连 Runtime，并在必要时恢复已知线程 |
| 找回任务 | `task_list` | 按项目或状态查找已保存的任务 |

概念上，一次调用会像这样：

```javascript
task_open({
  "projectRoot": "E:\\workspace\\my-app",
  "title": "为订单列表增加导出功能",
  "requirements": {
    "goal": "支持按当前筛选条件导出 Excel",
    "constraints": ["复用现有权限校验", "不要改变列表查询语义"]
  },
  "acceptanceCriteria": [
    "无权限用户不能导出",
    "导出字段与页面展示一致",
    "相关测试通过"
  ]
})
```

拿到 `taskId` 后，Claude 可以继续补充：

```javascript
task_send({
  "taskId": "<task-id>",
  "instruction": "产品补充要求：导出文件名需要包含当前日期，请在现有实现上继续修改。",
  "runChecks": true
})
```

第二次指令不会创建另一个孤立任务，而是进入同一个 Codex 线程。

## 适合哪些场景

下面只是常见例子，不是能力边界：

- 一个跨多个文件、需要多轮确认和返工的新功能；
- 先复现、再定位、再修复、最后补测试的 Bug 排查；
- 需要连续迁移多个调用方的重构或依赖升级；
- Codex 完成一轮后，由 Claude 审查 diff 并继续给出 review 意见；
- Claude 或 Bridge 可能中途重启，但任务不能丢失的长流程；
- 希望在可见 Codex TUI 中观察执行，同时仍由 Claude 统一下发任务；
- 需要保留审批与执行记录，又不希望日志淹没模型上下文的本地开发工作。

如果你的任务一次调用就能结束，Bridge 仍然可以工作；它真正体现价值的地方，是任务开始变长、变复杂、需要持续管理的时候。

## 快速开始

### 当前环境要求

- Windows 和 PowerShell；
- Node.js `>= 20.11.0`；
- 已安装并完成认证配置的 Codex CLI；
- 本地 Codex CLI 支持 `codex app-server`；
- 一个支持 stdio MCP 的客户端，例如 Claude Code。

当前 Runtime Host 和可见 TUI 的启动逻辑面向 Windows。其他平台还没有作为正式支持目标验证。

### 安装与构建

```powershell
git clone https://github.com/luojiateng/codex-bridge-mcp.git
cd codex-bridge-mcp
npm install
npm run build
```

构建完成后，入口文件位于 `dist/index.js`。

### 生成 MCP 配置

项目提供的脚本只负责输出配置片段，不会擅自修改你的全局配置：

```powershell
.\scripts\install-mcp.ps1
```

等价的核心配置如下，请把路径替换为本机绝对路径，并按所用 MCP 客户端的格式放入受信任配置：

```toml
[mcp_servers.codex_bridge]
command = "node"
args = ["C:\\absolute\\path\\codex-bridge-mcp\\dist\\index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 600
```

重新加载 MCP 客户端后，应能看到下面 9 个工具。

## 工具一览

| 工具 | 用途 |
| --- | --- |
| `task_open` | 创建任务并绑定一个 Codex 线程 |
| `task_send` | 在已有线程上发送后续指令 |
| `task_status` | 查看任务、Runtime、turn、审批、队列和上下文摘要 |
| `task_events` | 获取未投递或指定序号之后的增量事件 |
| `task_diff` | 获取任务对应工作区的 diff 摘要或 patch |
| `approval_decide` | 将 Claude 的批准或拒绝决定转发给 Codex |
| `task_compact` | 对任务绑定的 Codex 线程执行上下文压缩 |
| `task_recover` | 恢复任务、Runtime 和已知 Codex 线程 |
| `task_list` | 按项目或状态查找已保存任务 |

工具输入的准确 schema 位于 [`src/mcp/schemas.ts`](src/mcp/schemas.ts)，注册入口位于 [`src/mcp/tools.ts`](src/mcp/tools.ts)。

### 低噪音地读取任务信息

这三个读取工具默认优先返回足以继续决策的摘要，避免把历史事件、审批原文或大 diff 重复送进 Claude/Codex 上下文。需要排查时再明确展开：

- `task_status` 默认只返回待审批请求的可决策摘要；需要 Codex 的完整审批原文时传入 `includeApprovalPayload: true`。
- `task_events` 默认每页最多返回 20 条摘要事件，并返回 `nextAfterSeq` 和 `hasMore` 供后续翻页；需要原始事件内容时传入 `includePayload: true`。
- `task_diff` 默认返回短统计和最多 50 个变更文件；可用 `fileOffset`、`fileLimit` 翻页，`includeAllFiles: true` 获取完整文件列表，`includePatch: true` 获取行级 patch。

完整 payload 和 patch 没有被删除，只是不再作为默认上下文负担。

## 几条不会退让的保证

- 一个 `projectRoot` 最多只有一个活跃 Runtime Host；
- 一个 `taskId` 只绑定一个 `codexThreadId`；
- `thread/start` 只用于 `task_open`；
- 正常后续指令只通过 `turn/start`；
- `thread/resume` 只用于恢复，或重连后已知线程尚未加载的情况；
- `task_send` 不会启动 `codex resume`、`codex exec resume`、`cmd.exe` 或 `powershell.exe`；
- Bridge 不会自动批准 Codex 的审批请求；
- `task_status`、`task_events` 和 `task_diff` 默认返回短摘要，不默认倾倒完整日志；
- 中断的队列命令会被标记，不会自动重放可能已经执行过的修改；
- Codex turn 完成后，Claude 应先查看 `task_diff` 再接受结果。

## Runtime Host 和可见 Codex TUI 不是一回事

Runtime Host 是后台进程容器，负责运行：

```powershell
codex app-server --listen ws://127.0.0.1:<port>
```

它默认隐藏，因为那里主要是进程启动和协议日志，不是人和 Codex 对话的界面。

Bridge 还可以为任务打开一个可见的 Codex remote TUI：

- `CODEX_BRIDGE_CODEX_TUI_MODE=resume`：默认值，使用已知线程连接可见 TUI；
- `CODEX_BRIDGE_CODEX_TUI_MODE=remote`：连接 endpoint，但不指定线程；
- `CODEX_BRIDGE_CODEX_TUI_MODE=off`：不打开额外 TUI。

这里有一个容易混淆但很重要的边界：可见 TUI 可以通过 `codex resume --remote` 附着到线程，**但它只是观察和人工交互界面**。Claude 的 `task_send` 执行链仍然通过 App Server WebSocket 的 `turn/start`，不会靠 TUI 进程传递任务。

## 配置

所有配置都可以通过环境变量覆盖。未设置时使用本地默认值：

| 环境变量 | 默认值 / 作用 |
| --- | --- |
| `CODEX_BRIDGE_DATA_DIR` | Bridge 安装目录下的 `data` |
| `CODEX_BRIDGE_DB_PATH` | `data/bridge.db` |
| `CODEX_BRIDGE_LOGS_DIR` | `data/logs` |
| `CODEX_BRIDGE_RUNTIME_SCRIPTS_DIR` | `data/runtime-scripts` |
| `CODEX_BRIDGE_PORT_BASE` | `4510` |
| `CODEX_BRIDGE_PORT_SPAN` | `400` |
| `CODEX_BRIDGE_RUNTIME_START_TIMEOUT_MS` | `30000` |
| `CODEX_BRIDGE_RUNTIME_RECONNECT_TIMEOUT_MS` | `3000` |
| `CODEX_BRIDGE_CODEX_MODEL` | 默认继承当前 Codex 配置 |
| `CODEX_BRIDGE_CODEX_EFFORT` | 默认继承当前 Codex 配置 |
| `CODEX_BRIDGE_CODEX_SUMMARY` | `auto` / `concise` / `detailed` / `none` |
| `CODEX_BRIDGE_CODEX_VERBOSITY` | `low` / `medium` / `high` |
| `CODEX_BRIDGE_CODEX_SERVICE_TIER` | 默认继承当前 Codex 配置 |
| `CODEX_BRIDGE_CODEX_TUI_MODE` | `resume` |
| `CODEX_BRIDGE_RUNTIME_HOST_WINDOW` | `hidden` |

兼容变量 `CODEX_BRIDGE_SHOW_CODEX_TUI` 仍可控制是否显示 TUI，但新配置优先使用 `CODEX_BRIDGE_CODEX_TUI_MODE`。

`task_send` 还有一个单次调用级别的 `runChecks` 参数，默认是 `false`。Claude 可以根据任务风险决定这一轮是否值得让 Codex 额外运行验证命令。

## 本地数据与隐私

Bridge 本身运行在本机，不增加额外的云端中转层。Codex 是否访问网络，仍取决于你自己的 Codex 配置和授权。

默认会生成：

- `data/bridge.db`：任务、线程、事件、审批、队列和上下文快照；
- `data/logs/`：任务与 Runtime 的 JSONL 和进程日志；
- `data/runtime-scripts/`：Runtime Host 启动脚本。

这些路径已经被 `.gitignore` 排除。日志可能包含任务内容、命令、审批原因或 diff 信息，请仍然把它们当作本地敏感数据管理。

## 开发与验证

常用命令：

```powershell
npm run typecheck
npm run build
npm run check:forbidden
npm run smoke:protocol
npm run smoke:context
npm run smoke:queue
npm run smoke:recovery
npm run smoke:runtime-interruption
npm run smoke:diff
npm run smoke:mcp
```

这些 smoke 测试都是短生命周期验证，不会启动真实的长期 Runtime Host。

真实端到端验收使用：

```powershell
npm run e2e:real
```

它会启动或复用真实的 `codex app-server` 和 Runtime Host，并在临时 fixture 项目中完成两轮任务，因此只应在允许长期本地 Codex 进程运行时执行。

App Server TypeScript 协议类型来自本机 Codex CLI：

```powershell
npm run generate:codex-types
```

生成结果会由 `scripts/fix-generated-imports.mjs` 规范为 Node ESM 可用的导入路径。

## 当前状态

当前版本是一个面向 Windows 本地开发流程的可运行 MVP，已经覆盖：

- 长驻 Runtime 与线程复用；
- 9 个 MCP 工具；
- SQLite 与 JSONL 持久化；
- 审批转发；
- 事件、队列与恢复；
- 上下文提醒与压缩；
- diff 审查闭环；
- 可选 Codex remote TUI；
- 静态检查、mock smoke、MCP stdio smoke，以及真实 Runtime E2E 脚本。

更细的产品约束、阶段计划和验收矩阵见 [`docs/phase-development.md`](docs/phase-development.md)。

如果只记住一件事：**Codex Bridge MCP 不是为了让 Claude “调用一次 Codex”，而是为了让 Claude 能可靠地带着 Codex 把一项任务从开始做到验收。**
