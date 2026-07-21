## Context

当前 Loop 仅根据 Todo 的 `automation` 元数据计算只读 readiness，服务端明确不暴露执行端点。现有 Codex SDK Provider 面向一次性内容分析：使用空工作目录、只读沙箱、结构化输出，并拒绝工具活动；它不能直接承担长生命周期编码会话。新的人工 Loop 需要在保持单用户、本地优先、SQLite 机器真相、CSRF 和结构化日志约束的同时，引入可写仓库、流式事件、多轮对话和人工确认。

Todo Markdown 与 Meego 来源仍是事项真相，Agent 会话只是一次执行尝试。Agent 产生的代码、消息和完成判断不得反向覆盖 Todo 或 Meego。第一阶段只集成 Codex，但领域层必须避免绑定 SDK 具体类型。

## Goals / Non-Goals

**Goals:**

- 让用户从 Todo 或 Meego 显式创建绑定单一仓库的 Agent 会话。
- 为只读分析提供零 worktree 成本的强制只读模式，为代码修改提供会话级独立 worktree。
- 持久化会话、轮次、消息、事件、确认和工作区身份，并支持服务重启后继续对话。
- 在 Loop 中实时展示 Agent 状态、对话和人工确认请求。
- 保证 Agent 不会自动完成上游事项、提交外部状态、合并、push 或创建 MR。

**Non-Goals:**

- 定时、事件驱动或基于 `automation.mode` 的自动启动。
- 多 Agent、多仓库、跨会话编排和后台无人值守执行。
- 原仓库可写模式、自动权限提升、原生 Codex TUI 接管和通用 CLI 桥接。
- 自动清理含未提交修改或未合并提交的 worktree。

## Decisions

### 将人工会话与自动化策略分离

人工点击启动不读取或修改 Todo 的 `automation.mode`。`automation` 继续表示未来自动触发策略；人工会话使用独立 `AgentSession` 状态。这样默认 `disabled` 的 Todo 仍可由用户主动执行，也不会因为一次人工运行而意外获得自动执行授权。

### 使用两种工作模式而非通用路径权限

启动时必须选择：

- `read_only`：工作目录为注册路径的规范真实路径，可以是 Git 仓库或普通目录；Codex 使用 `read-only` 沙箱，不创建分支或 worktree。
- `isolated_worktree`：系统记录仓库当前 `HEAD` 为 `base_commit`，在 `<workspace>/.context/agent-worktrees/<repository-id>/<session-id>` 创建 `context-space/<session-id>` 分支和 worktree，Codex 使用 `workspace-write` 沙箱。

不提供原仓库可写模式。模式和 `base_commit` 在会话创建后不可变。只读会话需要写入时，系统创建待确认请求；用户批准后为同一会话配置新的独立 worktree，记录工作区切换系统事件，再开始后续轮次。

### 注册并规范化工作目录

工作目录作为 SQLite 实体管理。注册时服务端仅在输入恰好为 `~` 或以 `~/` 开头时展开当前进程用户主目录，再使用 `realpath` 验证目录并消除重复路径。若目录属于 Git 工作树，则使用 `git rev-parse --show-toplevel` 规范到仓库根目录并记录 HEAD；否则保存为普通目录，Git 元数据为空且只能用于只读模式。API 不把浏览器提交的路径直接作为命令片段，所有 Git 操作使用 `execFile` 参数数组。删除注册不会删除磁盘内容。

普通目录不提供隔离开发或只读升级能力。系统必须在启动或升级前返回明确错误，不能把普通目录复制成伪 worktree，也不能降级为原目录可写。

相比无界扫描整个主目录，显式注册使权限边界、启动列表和错误更可解释；后续可在不改变会话模型的情况下增加受控根目录发现。

### 以 Session、Turn、Event 和 Confirmation 分层持久化

新增 SQLite 表：

- `agent_repositories`：工作目录身份、类型、真实路径和可空 Git 元数据。
- `agent_sessions`：来源、工作模式、仓库、工作区、分支、基线、Codex Thread ID 和聚合状态。
- `agent_turns`：每次用户输入触发的执行状态、时间、usage 和错误。
- `agent_messages`：面向用户的对话消息与结构化结果。
- `agent_events`：命令、文件修改、状态和安全摘要的顺序投影。
- `agent_confirmations`：类型、问题、选项、状态与答案。

会话聚合状态只表示生命周期；`attention` 单独表示 `none`、`confirmation_required`、`reply_required` 或 `review_required`，避免把普通等待回复误判为审批。

### 通过运行时端口隔离 Codex SDK

领域服务依赖 `AgentRuntime` 接口：创建或恢复线程、流式运行一轮和取消。首个 `CodexAgentRuntime` 使用 `runStreamed()`，将 SDK 事件标准化后写入仓库。测试注入 Fake Runtime，不调用真实 Codex 或真实用户仓库。

每轮最终输出使用 JSON Schema，至少包含 `message`、`outcome`，并在需要时包含 `confirmation`。允许的 outcome 为 `completed`、`needs_confirmation`、`awaiting_reply` 和 `blocked`。结构化结果决定注意力分类，不解析自然语言猜测。

SDK 当前没有应用可回答的原生审批事件，因此运行使用 `approvalPolicy: never`，默认关闭网络。只读模式依靠只读沙箱，隔离开发模式只允许写会话 worktree。需要额外能力时 Agent 必须结束当前轮次并返回结构化确认，而不是停在不可见终端提示中。

### 异步执行并使用 SSE 投影状态

启动和发送消息 API 先原子创建 Session、Message 与排队 Turn，再由进程内 Coordinator 执行，HTTP 不等待 Agent 完成。Coordinator 对每个 Session 保证同一时间只有一个 Turn，并按顺序处理输入。前端通过单一 Loop SSE 端点接收会话投影失效通知，再按 ID 拉取规范详情；断线时可安全重连，SQLite 始终是恢复真相。

服务启动时将遗留 `running` Turn 标记为 `interrupted`，将 Session 置为等待回复并保留 Codex Thread ID。用户下一次发送消息时通过 `resumeThread()` 继续，不伪装中断轮次已经成功。

### worktree 清理必须保守

清理前检查未提交修改和相对基线的新提交。存在任一情况时创建人工确认，且默认仅保留。确认删除后依次执行 `git worktree remove` 和安全删除会话分支；失败时保留记录并展示可操作错误。系统永不使用递归删除清理未知路径。

## Risks / Trade-offs

- **[Codex 结构化终态不能表达真正的轮次中途审批]** → 第一阶段只在轮次边界请求确认，后续可增加本地 MCP 确认工具而不改变持久模型。
- **[服务退出会中断正在运行的 SDK 子进程]** → 将轮次标记为 `interrupted`，保留 Thread ID 和 worktree，要求用户显式继续。
- **[对话和命令输出可能包含敏感代码]** → 仅存本地 SQLite，限制事件大小，结构化日志只记录 ID、类型、计数和耗时，不记录 Prompt、消息正文或命令输出。
- **[worktree 与分支可能积累]** → Loop 展示 retained workspace，提供保守的人工清理流程，绝不静默删除未合并工作。
- **[只读仓库在运行期间发生外部变化]** → 会话记录启动时 `base_commit`，外部漂移不会静默切换基线；只读分析结果不宣称基于最新未提交内容之外的稳定快照。
- **[单进程 Coordinator 不适合多实例]** → 产品仍只允许 loopback 单实例；SQLite 状态与运行时端口为未来租约 Worker 保留替换空间。

## Migration Plan

1. 新增向前兼容 SQLite migration；旧工作区启动时创建空 Agent 表，不改写 Markdown。
2. 在 Settings 注册至少一个仓库后才展示可启动状态；没有仓库时启动面板引导配置。
3. 将现有 Loop readiness 数据保留在概览 API，但 Loop 主页面切换为会话工作台。
4. 回滚应用版本时新增表保持未使用状态；不得自动删除 worktree，用户可通过 Git 手动恢复。

## Open Questions

- 第一阶段只提供逐个显式注册仓库；受控根目录扫描留待后续 change。
- 原生 Codex 审批与轮次中途确认需要等待 SDK 或本地 MCP 方案成熟后单独设计。
