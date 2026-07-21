## ADDED Requirements

### Requirement: 事项上的 Agent 启动入口
工作台 SHALL 在可执行 Todo 和未完成 Meego 条目上提供可访问的“开始 Agent 干活”入口，并在启动前展示可编辑任务说明、已注册仓库和只读或隔离开发工作模式。

#### Scenario: 从 Meego 打开启动面板
- **WHEN** 用户点击未完成 Meego 条目的 Agent 按钮
- **THEN** 面板预填事项标题与来源，要求用户选择仓库和工作模式后才能提交

#### Scenario: 已完成事项不提供启动
- **WHEN** Todo 已完成、等待他人或 Meego 已完成
- **THEN** 工作台不提供可提交的 Agent 启动动作

### Requirement: Agent 会话工作台
Loop SHALL 使用会话列表、对话区域和工作上下文区域展示真实 Agent Session；用户 SHALL 能查看当前状态、来源、仓库、工作区、分支、消息、命令与文件修改摘要。

#### Scenario: 查看运行中会话
- **WHEN** Agent Turn 正在产生流式事件
- **THEN** Loop 实时更新会话状态与有界事件投影，无需整页刷新

### Requirement: 会话对话与确认交互
Loop SHALL 允许用户向空闲或运行中会话发送后续消息、回答 pending Confirmation、停止 Turn 和验收结果，并 SHALL 在失败时保留已输入内容和展示错误。

#### Scenario: 回答人工确认
- **WHEN** 用户选择确认选项并提交成功
- **THEN** UI 将确认显示为已回答并在同一会话中展示由答案创建的后续消息

### Requirement: 仓库配置界面
Settings SHALL 允许用户注册、查看和移除仓库记录，展示规范路径与 Git 元数据；移除注册 MUST NOT 删除磁盘仓库或活跃会话工作区。

#### Scenario: 注册仓库
- **WHEN** 用户提交有效 Git 仓库路径
- **THEN** Settings 展示仓库名称、规范路径和当前分支，并可在 Agent 启动面板选择
