## ADDED Requirements

### Requirement: 人工创建 Agent 会话
系统 SHALL 只在用户显式提交启动请求后，根据一个 Todo 或未完成 Meego 来源、一个已注册仓库、可编辑任务说明和工作模式创建 Agent 会话；系统 MUST NOT 根据同步、优先级或自动化元数据自动启动会话。

#### Scenario: 从开放 Todo 启动
- **WHEN** 用户确认开放且非等待他人的 Todo、任务说明、仓库和工作模式
- **THEN** 系统持久化一个引用该 Todo 的 Agent 会话并排队首个 Turn

#### Scenario: 同步完成不自动启动
- **WHEN** Lark 或 Meego 同步创建或更新了可执行事项
- **THEN** 系统不创建 Agent 会话且不调用 Agent Runtime

### Requirement: 持久多轮对话
系统 SHALL 为每个会话持久化用户消息、Agent 消息、Turn、标准化事件和 Codex Thread ID；同一会话后续消息 MUST 串行恢复同一 Thread，不得并发执行两个 Turn。

#### Scenario: 继续已有会话
- **WHEN** 用户在一个空闲会话中发送后续消息
- **THEN** 系统持久化消息、通过已保存 Thread ID 开始新 Turn，并将流式事件关联到同一会话

#### Scenario: 运行时收到下一条消息
- **WHEN** 用户在当前 Turn 仍运行时发送消息
- **THEN** 系统将消息和 Turn 持久排队，并在当前 Turn 结束后按顺序执行

### Requirement: 可恢复的运行状态
系统 SHALL 区分会话生命周期、Turn 执行状态和注意力状态，并在服务启动时把遗留运行中 Turn 标记为中断；中断 MUST 保留消息、Thread ID、仓库和工作区。

#### Scenario: 服务在 Turn 中退出
- **WHEN** 服务重新启动且 SQLite 存在 `running` Turn
- **THEN** 系统将该 Turn 标记为 `interrupted`，会话进入等待用户继续状态，且不会记录虚构的成功响应

### Requirement: 受控终止和验收
用户 SHALL 能停止运行中的 Turn、结束会话和人工验收 Agent 结果；Agent 报告完成 MUST 只产生待验收状态，不得自动完成 Todo、修改 Meego、合并、push 或创建 MR。

#### Scenario: Agent 报告完成
- **WHEN** Agent Turn 返回 `completed`
- **THEN** 会话进入 `review_required`，来源事项和外部仓库状态保持不变

#### Scenario: 用户停止运行
- **WHEN** 用户停止一个运行中的 Turn
- **THEN** 系统取消该 Turn、保留会话历史与工作区，并允许后续继续对话

### Requirement: 本地流式事件
系统 SHALL 将 Agent 状态变化作为可重连的本地 SSE 失效通知发布，并以 SQLite 详情 API 作为规范读取来源；事件和日志 MUST NOT 暴露凭证或不受限的命令输出。

#### Scenario: Agent 执行命令
- **WHEN** Runtime 发出命令开始、更新或完成事件
- **THEN** 系统保存有界事件投影并通知已连接的 Loop 客户端刷新对应会话

### Requirement: 可诊断的 Turn 失败
系统 SHALL 持久化失败、中断或取消 Turn 的有界错误，并在 Loop 对话区展示状态、错误与工作区保留提示；失败 MUST NOT 表现为无响应，也不得自动重跑可能已产生副作用的原始 Prompt。

#### Scenario: Codex 请求失败
- **WHEN** Runtime 在生成有效结构化终态前失败
- **THEN** Turn 被标记为失败，Loop 展示错误并允许用户在保留的会话和工作区上继续对话
