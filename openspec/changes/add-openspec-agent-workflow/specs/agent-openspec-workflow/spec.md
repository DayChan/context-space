## ADDED Requirements

### Requirement: OpenSpec 会话类型
系统 SHALL 将 OpenSpec 工作流作为独立于工作区读写模式的 Agent 会话类型持久化，并 MUST 仅允许 Git 仓库的隔离开发会话启用该类型。

#### Scenario: 创建 OpenSpec 隔离会话
- **WHEN** 用户为 Git 仓库选择隔离开发并启用 OpenSpec 工作流
- **THEN** 系统创建带有 `openspec` 工作流类型的独立 worktree 会话

#### Scenario: 拒绝不兼容模式
- **WHEN** 用户尝试为只读模式或普通目录启用 OpenSpec 工作流
- **THEN** 服务端拒绝请求且不创建 Agent 会话或可写工作区

### Requirement: OpenSpec readiness 与显式初始化
系统 MUST 在创建 OpenSpec 会话前检查所选仓库是否包含 OpenSpec 项目结构和 Codex OpenSpec skills；缺失时 SHALL 要求用户显式决定是否初始化。用户拒绝或初始化失败时 MUST NOT 持久化会话，并 SHALL 回滚临时 worktree。

#### Scenario: 用户拒绝初始化
- **WHEN** 仓库尚未初始化 OpenSpec 且用户拒绝初始化
- **THEN** 启动流程结束，不创建 Session、Turn、分支或 worktree

#### Scenario: 在隔离工作区初始化
- **WHEN** 用户同意为未初始化仓库启用 OpenSpec
- **THEN** 系统先创建临时 worktree，在其中执行受控初始化并校验结果，成功后才持久化 Session 与首个 Turn

#### Scenario: 初始化失败
- **WHEN** OpenSpec CLI 初始化失败或初始化后缺少必要结构
- **THEN** 系统返回可操作错误、移除临时 worktree 和分支，且不创建会话

#### Scenario: 使用通用 Agent skill 目录
- **WHEN** 必需的 OpenSpec skills 存在于项目的 `.agents/skills`，但 `.codex/skills` 不存在或未被 Git 跟踪
- **THEN** 系统将仓库及其隔离 worktree 判定为 skills 已就绪，不要求重复初始化

#### Scenario: 混合使用 skill 根目录
- **WHEN** 每个必需 OpenSpec skill 分别存在于 `.codex/skills` 或 `.agents/skills` 任一目录
- **THEN** 系统仅在某个必需 skill 在两个目录中都缺失时报告该 skill 未就绪

### Requirement: 首轮探索 Skill
系统 SHALL 在 OpenSpec 会话首条任务说明前加入 `$openspec-explore`，但用户说明已经以 `$openspec-explore` 或 `/openspec-explore` 开头时 MUST NOT 重复加入。

#### Scenario: 自动添加探索 Skill
- **WHEN** 用户提交未包含 OpenSpec 探索命令的任务说明
- **THEN** 首个持久化用户消息以 `$openspec-explore` 开头并保留原始说明

### Requirement: Schema 驱动的工作流投影
系统 SHALL 从 change 声明的 OpenSpec schema 读取 artifact 节点和依赖，并使用 `openspec status --json` 根据实际输出 Markdown 计算 `done`、`ready`、`blocked` 状态；系统 MUST NOT 在前端硬编码固定 artifact 顺序。

#### Scenario: 展示分支工作流
- **WHEN** schema 定义一个 artifact 同时解锁两个后继节点
- **THEN** API 返回节点依赖和状态，UI 将其展示为分支而不是错误的单一直线

#### Scenario: Artifact 文件产生后刷新
- **WHEN** Agent 在 change 目录创建 schema 声明的 Markdown 输出
- **THEN** 后续工作流读取通过 OpenSpec status 将对应节点显示为已完成

### Requirement: 多 Change 管理
OpenSpec 会话 SHALL 允许用户通过 `$openspec-new-change` 创建多个合法 kebab-case change，并 SHALL 提供 change 列表、当前选择和各自独立的 schema workflow 投影。所有 change 共享该会话的 Codex Thread、worktree 和验收生命周期。

#### Scenario: 请求新建 Change
- **WHEN** 用户提交合法 change 名称
- **THEN** 系统在同一会话排队一条调用 `$openspec-new-change` 的 Turn，并在 change 目录出现后将其加入列表

#### Scenario: 切换 Change
- **WHEN** 一个会话存在多个 active change 且用户选择另一个 change
- **THEN** UI 读取并展示所选 change 自己的 schema、路径和 artifact 状态

#### Scenario: 拒绝不安全名称
- **WHEN** change 名称不是合法 kebab-case 或包含路径穿越字符
- **THEN** 服务端在创建 Turn 前拒绝请求
