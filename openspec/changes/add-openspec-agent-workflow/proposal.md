## Why

当前人工 Agent 会话只能直接执行任务，缺少以 OpenSpec change 为中心的需求澄清、规格产物和可视化进度。用户需要在隔离 worktree 中安全初始化 OpenSpec、调用对应 Codex skills，并根据仓库实际 schema 与 Markdown 产物持续观察多个 change 的工作流状态。

## What Changes

- 为隔离开发会话增加可选的 OpenSpec 工作流类型，并在服务端为首条任务说明注入 `$openspec-explore`。
- 在创建会话前检查仓库的 OpenSpec readiness；缺失时要求用户显式同意初始化，拒绝或初始化失败均不创建会话。
- 在会话 worktree 中运行受控的 OpenSpec 初始化，并校验 `openspec/` 与 `.codex/skills` 或 `.agents/skills` 中的 OpenSpec skills。
- 增加基于 OpenSpec CLI/schema 的 change 列表与工作流投影，根据实际 Markdown 输出显示 `done`、`ready`、`blocked` 节点。
- 在会话中支持通过 `$openspec-new-change` 创建多个 change，并通过下拉列表切换查看各 change 的 workflow。
- Loop 会话框展示 OpenSpec workflow，并在 Agent 文件事件或 Turn 完成后刷新实际进度。

## Capabilities

### New Capabilities

- `agent-openspec-workflow`: 定义 OpenSpec Agent 会话的 readiness、隔离初始化、skill 调用、change 管理和 schema 驱动进度投影。

### Modified Capabilities

- `context-workbench-ui`: 扩展 Agent 启动面板与 Loop 会话工作台，展示 OpenSpec 选择、初始化确认、change 切换和 workflow DAG。

## Impact

- 影响 Agent Session SQLite schema、Repository、Agent 启动服务和 Codex Prompt 构造。
- 新增受控 OpenSpec CLI runner、readiness/change/workflow API，并继续受本地 CSRF 保护。
- 影响 Todo/Meego Agent 启动面板、Loop 会话区域、SSE 刷新和相关测试。
- OpenSpec workflow schema 属于实验接口，实现需要隔离 CLI JSON/Schema YAML 兼容边界。
