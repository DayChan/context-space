## ADDED Requirements

### Requirement: OpenSpec Agent 启动交互
Agent 启动面板 SHALL 在用户选择 Git 仓库的隔离开发模式时提供 OpenSpec 工作流选项，并 SHALL 展示 readiness 检查、初始化确认和失败状态；普通目录或只读模式不得提交 OpenSpec 会话。

#### Scenario: 显示初始化确认
- **WHEN** 用户为未初始化仓库勾选 OpenSpec 工作流并提交
- **THEN** 面板解释将执行的初始化操作，并要求用户选择“初始化并创建”或取消

#### Scenario: 切换为只读模式
- **WHEN** 用户已勾选 OpenSpec 后切换为只读分析
- **THEN** 面板清除或禁用 OpenSpec 选项，提交数据不包含 OpenSpec 工作流

### Requirement: 会话中的 OpenSpec Workflow
Loop SHALL 在 OpenSpec 会话的对话区域展示 change 操作栏、change 下拉列表和 schema 驱动的完整 workflow；节点 MUST 区分已完成、可继续和被依赖阻塞状态，并在会话事件发生后刷新。

#### Scenario: 首次进入 OpenSpec 会话
- **WHEN** OpenSpec 会话尚无 change
- **THEN** workflow 区域展示“新建 Change”入口和空状态，而不虚构 artifact 进度

#### Scenario: 查看多个 Change
- **WHEN** 会话 worktree 包含多个 change
- **THEN** 用户可从下拉列表切换，workflow 区域同步展示对应 change 名称、schema、相对路径和节点进度

#### Scenario: 创建 Change
- **WHEN** 用户从 workflow 区域提交 change 名称
- **THEN** UI 调用受 CSRF 保护的创建接口、展示排队状态，并在 Agent 创建目录后刷新 change 列表
