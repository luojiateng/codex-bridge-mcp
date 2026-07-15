# Codex Bridge MCP

> 让 Claude 或 Codex 负责决策，让 Codex 在同一个任务中持续、可控地完成执行。

Codex Bridge MCP 是连接 **任务编排者**（Claude Code 或 Codex）与 **Codex App Server** 的本地 MCP。它不是另一个模型，也不是把一条提示词转发给 Codex 的脚本；它为一项开发任务保留稳定的执行线程、运行状态、审批记录和审阅闭环。

当需求需要多轮补充、代码修改需要审批、任务可能中断、结果还需要审查时，Claude 不必每次重新解释上下文，也不必把 Codex 的一句“完成”当作验收结果。

## 它为谁而做

适合已经同时使用 Claude 与 Codex，并希望把它们用在真实工程任务中的开发者和团队：

- Claude 擅长理解需求、拆解问题、作出判断和审查结果；
- Codex 擅长进入仓库、修改文件、执行命令和完成验证；
- 你需要的是一条不会在多轮协作中断掉的执行链。

Claude 是默认、最清晰的协作入口；如果你已经使用 Codex 作为上层编排者，也可以让 Codex 通过同一组 MCP 工具调度一个独立的 Codex Runtime。

## 解决的问题

一次性调用 Codex 很容易；难的是让一项复杂任务可靠地走到验收。

| 真实开发中的问题 | Codex Bridge MCP 的做法 |
| --- | --- |
| 需求补充几轮后，执行上下文散失 | 一个任务持续绑定同一个 Codex 线程，后续要求进入同一执行链 |
| 同一项目反复启动执行环境 | 一个 `projectRoot` 复用一个活跃 Runtime Host |
| 高风险命令不该被自动放行 | Codex 的审批请求由任务编排者明确批准或拒绝，Bridge 不会自动批准 |
| Claude、Bridge 或电脑重启后任务失联 | 保存任务、线程、事件和队列状态；优先重连，必要时恢复已知线程 |
| 任务完成却无法判断是否真的符合要求 | Claude 获取真实 diff，继续 review 或下发下一轮要求 |
| 日志、事件与 patch 淹没模型上下文 | 默认返回摘要和分页信息，需要时才显式展开原始内容 |

## 一项任务如何流转

```text
你提出目标与约束
        │
        ▼
Claude / Codex  澄清需求、拆解任务、决定审批、审查结果
        │ stdio MCP（兼容入口）
        ▼
Bridge Adapter  自动连接或拉起共享 Core，不持有任务状态
        │ 本地 Streamable HTTP MCP
        ▼
Bridge Core  唯一持有任务、线程、Runtime、TUI、审批与恢复状态
        │ WebSocket JSON-RPC
        ▼
Codex   在真实仓库中修改代码、执行命令、完成验证
```

一次任务通常只有下面几步：

1. Claude 用 `task_open` 连接项目会话；Bridge 默认复用该项目已经绑定的 Task、Codex 线程和 TUI，仅在没有会话时创建。
2. Claude 用 `task_send` 发送补充要求；Bridge 会先确认同一线程的可见 TUI 仍在运行，再启动 Codex turn，并保持等待直到审批、完成、失败或中断。客户端支持 MCP progress 时，等待期间 Bridge 会发送轻量进度心跳；即使 MCP 调用被取消，最终注意力事件也会先持久化，重连后由 `task_open`、`task_send` 或 `task_status` 重放。只有显式配置 `CODEX_BRIDGE_CODEX_TUI_MODE=off` 才允许无窗口执行。
3. Codex 需要授权时，`task_send` 会直接返回审批注意力事件；Claude 通过 `approval_decide` 作出决定，并继续等待同一 turn 的下一个注意力事件。
4. Codex 完成一轮后，Claude 用 `task_diff` 审查真实改动；不满足验收条件就继续发送下一轮要求。`task_status` 和 `task_events` 只用于诊断与审计，不承担正常通知职责。
5. 长任务接近上下文限制时，Claude 可以调用 `task_compact`，在原线程中压缩上下文。

## 核心价值

### 持续执行，而不是一次转发

`taskId` 与 `codexThreadId` 一一绑定。Bridge 将项目当前会话保存在 SQLite 中，因此即使 MCP 重连、进程重启或编排者暂时丢失 `taskId`，再次调用 `task_open` 也会返回原 Task 和线程，不会意外打开第二个 TUI。只有明确传入 `mode: "new"`，才会创建隔离的新会话。

### Codex 也可以调度 Codex

Bridge 支持两种编排方式：

```text
Claude Code → Codex Bridge MCP → Codex Runtime
Codex      → Codex Bridge MCP → 独立 Codex Runtime
```

在第二种方式中，上游 Codex 是任务编排者：它调用 `task_open`、`task_send`、`task_status` 和 `task_diff`，Bridge 则启动或复用一个**独立的** Codex App Server Runtime 执行实际工作。它不是让同一个 Codex 会话递归调用自己，因此仍然保留清晰的任务边界、审批链、恢复状态和 diff 审阅链。

### 审批可控，责任清晰

Bridge 只保存和转发审批请求，不替任务编排者或用户作决定。命令执行、文件修改等需要授权的操作，都要经过明确的 `approve` 或 `deny`。审批、完成、失败和中断都会保存为带单调 revision 的 turn 注意力状态；编排者完成对应动作后才写入 ACK。未确认事件会在调用取消或客户端重连后重放，避免只写入后台日志却没有交付给编排者。

### 中断可恢复，而不是静默重跑

Bridge 会记录 Runtime、线程、turn 和队列状态。Core 重启后通过 `thread/read` 将本地活跃 turn 与 App Server 实际状态对账；无法确认已完成的工作会被标记为中断，避免把可能已经生效的修改自动再执行一次。旧 App Server 连接上的待审批会标记为 `orphaned`，不会被自动批准、自动拒绝或错误地发送到替代连接。

### 一个 Core，而不是每个客户端一套运行时

Claude、Codex 或它们的新会话都连接到同一个本地 Bridge Core。MCP 客户端连接只是临时的协议会话；SQLite、Runtime WebSocket、任务队列和审批请求由 Core 长期持有。关闭或重连一个 MCP 客户端不会触发全库恢复，也不会为同一 Runtime 再创建一条 App Server WebSocket。

### 结果可审阅，而不是相信“已完成”

Codex 的完成事件只是提示 Claude 进入审查。Bridge 提供工作区 diff、变更文件和可选 patch，让验收基于真实代码，而不是自然语言声明。

### 上下文更干净

状态、事件和 diff 默认返回可用于继续决策的短摘要：

- 审批请求默认只给出可决策信息；需要原文时再请求完整 payload；
- 事件默认按页返回，并提供游标继续读取；
- diff 默认给出短统计与分页文件列表；只有行级审阅时才请求完整 patch。

这让 Claude 与 Codex 把上下文留给任务本身，而不是重复的日志和历史数据。

## 产品边界

Codex Bridge MCP 的职责是可靠地协同 Claude 与 Codex，不替代任何一方：

- **不是新的模型**：不会替任务编排者规划，也不会替 Codex 编写实现；
- **不是云端代理**：Bridge 本身运行在本机，不增加额外的云端中转；
- **不会自动批准操作**：审批权始终属于任务编排者和用户；
- **不会用 TUI 传递任务**：正常任务通过 App Server 的 `turn/start` 进入 Codex。可见 TUI 仅用于观察或人工交互。

当前 Runtime Host 与可见 Codex TUI 的启动流程主要面向 Windows + PowerShell 验证。

## 快速开始

### 前置条件

- Windows 与 PowerShell；
- Node.js `>= 20.11.0`；
- 已安装并完成认证的 Codex CLI，且支持 `codex app-server`；
- 支持 stdio MCP 的客户端，例如 Claude Code 或 Codex；也可以直接连接 Streamable HTTP MCP。

### 安装与构建

```powershell
git clone https://github.com/luojiateng/codex-bridge-mcp.git
cd codex-bridge-mcp
npm install
npm run build
```

构建完成后，`dist/index.js` 是稳定的 stdio MCP 入口。它会自动连接或拉起一个只监听 `127.0.0.1` 的共享 Bridge Core，不需要另开终端管理 Core。运行脚本生成配置片段：

```powershell
.\scripts\install-mcp.ps1
```

Codex 的配置形态如下：

```toml
[mcp_servers.codex_bridge]
command = "node"
args = ["C:\\absolute\\path\\codex-bridge-mcp\\dist\\index.js"]
cwd = "C:\\absolute\\path\\codex-bridge-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 600
```

Claude Code 使用同一个 `node dist/index.js` stdio 命令即可。多个 Codex/Claude 客户端只会创建各自的轻量 Adapter；所有 Adapter 都连接同一个 Core，因此客户端退出不会关闭正在执行的 Codex turn，也不会重新执行全库恢复。

每次 `npm run build` 都会生成新的 Bridge build ID。stdio Adapter 发现端口上仍是旧 build 的 Core 时会明确报告 PID 和版本不兼容，不会静默复用旧代码或自动终止正在运行的任务；确认没有活跃任务后再重启该 Core。进度心跳默认每 15 秒发送一次，可用 `CODEX_BRIDGE_ATTENTION_HEARTBEAT_MS` 调整。

需要调试或让支持 Streamable HTTP 的客户端直接连接时，可以显式启动 Core：

```powershell
npm start
```

默认地址是 `http://127.0.0.1:43110/mcp`，本地令牌保存在 `data/mcp-token`。这是可选的直连方式；普通 stdio 安装不需要手工读取或配置令牌。

## Core 生命周期与升级

Bridge Core 默认采用**按需启动**，不是 Windows 开机自启服务：第一次由 Claude Code 或 Codex 建立 MCP 连接时，stdio Adapter 会在本机没有可用 Core 的情况下拉起共享 Bridge Core；任务需要执行环境时，再由 Core 的 Runtime Host Manager 为对应项目启动 `codex app-server`。关闭单个客户端不会停止 Core，也不会中断已经提交的 Codex turn。日常使用不需要每次手工执行 `npm start`；该命令主要用于前台诊断。

构建升级后，新的 Adapter 不会自动终止仍在运行的旧 Core，因为旧进程中可能还有任务或待审批操作。此时仅反复执行 `/mcp` 无法替换不兼容的旧进程，客户端会返回 `Failed to reconnect to codex-bridge: -32000`。可以先读取健康信息：

```powershell
$health = Invoke-RestMethod http://127.0.0.1:43110/healthz
$health
```

如果返回的 `protocolVersion` 或 `buildId` 与当前构建不一致，先通过原客户端确认没有运行中的任务和待审批操作，再停止健康信息中给出的旧 PID：

```powershell
Stop-Process -Id $health.pid
```

随后重新连接 MCP 即可，由 stdio Adapter 按需启动当前构建的 Core；Claude Code 可重新执行 `/mcp`，Codex 可重新加载 MCP 配置。若需要查看启动阶段的直接错误，再在项目目录运行 `npm start` 进行前台诊断。

> 不要在任务执行中或存在待审批操作时直接停止 Core。Bridge 会持久化可恢复状态，但不会假装未确认的外部操作一定没有发生。

## 常用能力

| 你想做什么 | 编排者使用的能力 |
| --- | --- |
| 连接或开始一项持续任务 | `task_open`（默认 `mode: "reuse"`） |
| 明确开启隔离的新线程 | `task_open`（`mode: "new"`） |
| 在原任务上继续补充要求 | `task_send` |
| MCP 调用取消或重连后继续等待 | `task_await`；未 ACK 的结果也会由 `task_open` / `task_send` 重放 |
| 诊断进度、队列和历史事件 | `task_status`、`task_events` |
| 审批或拒绝 Codex 操作 | `approval_decide` |
| 审查真实代码改动 | `task_diff` |
| 压缩长任务上下文 | `task_compact` |
| 重连或找回任务 | `task_recover`、`task_list` |

完整工具 schema 请见 [`src/mcp/schemas.ts`](src/mcp/schemas.ts)。产品约束、阶段计划和验收矩阵请见 [`docs/phase-development.md`](docs/phase-development.md)。

## 本地数据与隐私

Bridge 在本机保存任务、线程、语义事件、审批、队列和上下文快照，以实现恢复与审阅。默认数据目录位于 Bridge 安装目录下的 `data/`，其中可能包含任务内容、命令、审批原因和 diff 信息；`data/mcp-token` 是本地 HTTP 访问令牌。

这些本地运行数据、日志和 `.env` 已被项目 `.gitignore` 排除。请像管理本地开发日志一样管理它们，并不要把真实凭据写入任务说明、环境示例或仓库文件。

App Server 的逐 token / delta 输出不会写入 SQLite 事件表；Bridge 只持久化审批、turn 完成/中断、上下文阈值和错误等可恢复的语义事实，从源头减少 Claude 与 Codex 读取噪音历史时的 Token 消耗。

## 开发验证

```powershell
npm run typecheck
npm run build
npm run check:forbidden
npm run smoke:protocol
npm run smoke:context
npm run smoke:queue
npm run smoke:recovery
npm run smoke:runtime-interruption
npm run smoke:project-session
npm run smoke:attention
npm run smoke:diff
npm run smoke:mcp
```

真实端到端验证使用 `npm run e2e:real`。它会启动或复用真实的 Codex App Server，因此应只在允许本机 Codex Runtime 运行的环境中执行。

---

**Codex Bridge MCP 不只是让 Claude 或 Codex 调用一次 Codex，而是让编排者能可靠地把一项开发任务从目标推进到验收。**
