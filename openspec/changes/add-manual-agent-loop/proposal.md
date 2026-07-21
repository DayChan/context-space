## Why

Context Space 当前只能整理 Todo 与 Meego 上下文，Loop 仍是不可执行的就绪度占位，用户必须离开工作台手动打开仓库和 Agent，导致事项、执行过程、对话与人工决策彼此割裂。现在需要先建立一个严格由用户触发的本地 Agent 工作台，在不引入自动调度的前提下闭合“发现工作—选择仓库—执行—确认—验收”的链路。

## What Changes

- 在符合条件的 Todo 和未完成 Meego 条目上增加“开始 Agent 干活”入口，并要求用户在启动前确认任务说明、仓库与工作模式。
- 增加仓库注册与校验能力，只允许从已配置仓库启动会话。
- 提供“只读分析”和“隔离开发”两种互斥模式：只读模式在原仓库使用只读沙箱，隔离开发模式从固定基线创建会话专属 Git worktree 和分支。
- 增加持久 Agent Session、Turn、Event、Message 与 Confirmation Request，将 Codex Thread 和运行投影保存在 SQLite，并通过流式事件更新 Loop。
- 将 Loop 从只读 readiness 占位升级为人工 Agent 工作台，展示正在执行、需要人工确认、等待回复和最近结束的会话，并支持继续对话、停止、恢复与人工验收。
- Agent 的完成结论不会自动完成 Todo、修改 Meego、提交、合并、push 或创建 MR；所有外部状态仍由用户显式处理。
- 第一阶段只支持人工启动和单 Agent Codex Runtime，不增加定时触发、自动选仓、多 Agent 编排或无人值守自动化。

## Capabilities

### New Capabilities
- `agent-session-runtime`: 定义人工启动、持久会话、多轮对话、流式事件、恢复和终止语义。
- `agent-workspace-management`: 定义仓库注册、只读原仓库模式、隔离 worktree 模式、固定基线和安全清理。
- `agent-human-confirmation`: 定义 Agent 结构化请求人工决策、动作批准和完成验收的生命周期。

### Modified Capabilities
- `automation-loop-readiness`: 将 Loop 从禁止任何执行的占位界面改为仅允许人工触发的 Agent 工作台，同时继续禁止自动触发。
- `context-workbench-ui`: 增加 Todo 与 Meego 启动入口、Agent 启动面板、实时对话和 Loop 会话分类。

## Impact

- 后端新增 SQLite 表、Repository 与 Agent Runtime 服务、Codex SDK 流式执行适配器、Git worktree 管理和 Loop API。
- 前端修改 Todo、Meego、Loop 与 Settings 页面，并增加 SSE 事件消费与人工确认交互。
- 继续复用现有 `@openai/codex-sdk`、本地认证、CSRF、结构化日志和 SQLite 基础设施，不引入远程服务。
- Agent 会在用户选择的代码仓库或专属 worktree 中读取或修改文件；默认不启用网络，不提供原仓库可写模式。
