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
| 高风险命令不该被自动放行 | Codex 的审批请求由 Claude 明确批准或拒绝，Bridge 不会自动批准 |
| Claude、Bridge 或电脑重启后任务失联 | 保存任务、线程、事件和队列状态；优先重连，必要时恢复已知线程 |
| 任务完成却无法判断是否真的符合要求 | Claude 获取真实 diff，继续 review 或下发下一轮要求 |
| 日志、事件与 patch 淹没模型上下文 | 默认返回摘要和分页信息，需要时才显式展开原始内容 |

## 一项任务如何流转

```text
你提出目标与约束
        │
        ▼
Claude  澄清需求、拆解任务、决定审批、审查结果
        │ MCP
        ▼
Bridge  绑定任务、线程和 Runtime；保存事件、状态与审阅信息
        │ WebSocket JSON-RPC
        ▼
Codex   在真实仓库中修改代码、执行命令、完成验证
```

一次任务通常只有下面几步：

1. Claude 用 `task_open` 创建任务，Bridge 启动或复用该项目的 Runtime，并绑定一个 Codex 线程。
2. Claude 用 `task_send` 发送补充要求；每一轮都通过同一线程的 `turn/start` 执行，而不是新开一个孤立会话。
3. Codex 需要授权时，Claude 查看任务状态并通过 `approval_decide` 作出明确决定。
4. Codex 完成一轮后，Claude 用 `task_diff` 审查真实改动；不满足验收条件就继续发送下一轮要求。
5. 长任务接近上下文限制时，Claude 可以调用 `task_compact`，在原线程中压缩上下文。

## 核心价值

### 持续执行，而不是一次转发

`taskId` 与 `codexThreadId` 一一绑定。任务经历需求补充、修复、验证和 review 时，Codex 始终在已知上下文中继续工作。

### Codex 也可以调度 Codex

Bridge 支持两种编排方式：

```text
Claude Code → Codex Bridge MCP → Codex Runtime
Codex      → Codex Bridge MCP → 独立 Codex Runtime
```

在第二种方式中，上游 Codex 是任务编排者：它调用 `task_open`、`task_send`、`task_status` 和 `task_diff`，Bridge 则启动或复用一个**独立的** Codex App Server Runtime 执行实际工作。它不是让同一个 Codex 会话递归调用自己，因此仍然保留清晰的任务边界、审批链、恢复状态和 diff 审阅链。

### 审批可控，责任清晰

Bridge 只保存和转发审批请求，不替 Claude 或用户作决定。命令执行、文件修改等需要授权的操作，都要经过明确的 `approve` 或 `deny`。

### 中断可恢复，而不是静默重跑

Bridge 会记录 Runtime、线程、turn 和队列状态。重启后优先重新连接仍存活的 App Server；无法确认已完成的运行中工作会被标记为中断，避免把可能已经生效的修改自动再执行一次。

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
- 支持 stdio MCP 的客户端，例如 Claude Code 或 Codex。

### 安装与构建

```powershell
git clone https://github.com/luojiateng/codex-bridge-mcp.git
cd codex-bridge-mcp
npm install
npm run build
```

构建完成后，MCP 入口为 `dist/index.js`。可以使用脚本生成配置片段：

```powershell
.\scripts\install-mcp.ps1
```

将输出中的绝对路径加入 MCP 客户端配置。核心配置形态如下：

```toml
[mcp_servers.codex_bridge]
command = "node"
args = ["C:\\absolute\\path\\codex-bridge-mcp\\dist\\index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 600
```

重新加载 MCP 客户端后，Claude 或 Codex 即可创建和协同 Codex 任务。

## 常用能力

| 你想做什么 | 编排者使用的能力 |
| --- | --- |
| 开始一项持续任务 | `task_open` |
| 在原任务上继续补充要求 | `task_send` |
| 查看进度、队列、审批和上下文提醒 | `task_status`、`task_events` |
| 审批或拒绝 Codex 操作 | `approval_decide` |
| 审查真实代码改动 | `task_diff` |
| 压缩长任务上下文 | `task_compact` |
| 重连或找回任务 | `task_recover`、`task_list` |

完整工具 schema 请见 [`src/mcp/schemas.ts`](src/mcp/schemas.ts)。产品约束、阶段计划和验收矩阵请见 [`docs/phase-development.md`](docs/phase-development.md)。

## 本地数据与隐私

Bridge 在本机保存任务、线程、事件、审批、队列和上下文快照，以实现恢复与审阅。默认数据目录位于 Bridge 安装目录下的 `data/`，其中可能包含任务内容、命令、审批原因和 diff 信息。

这些本地运行数据、日志和 `.env` 已被项目 `.gitignore` 排除。请像管理本地开发日志一样管理它们，并不要把真实凭据写入任务说明、环境示例或仓库文件。

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
npm run smoke:diff
npm run smoke:mcp
```

真实端到端验证使用 `npm run e2e:real`。它会启动或复用真实的 Codex App Server，因此应只在允许本机 Codex Runtime 运行的环境中执行。

---

**Codex Bridge MCP 不只是让 Claude 或 Codex 调用一次 Codex，而是让编排者能可靠地把一项开发任务从目标推进到验收。**
