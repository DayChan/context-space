## ADDED Requirements

### Requirement: 事项上的 Agent 启动入口
工作台 SHALL 在可执行 Todo 和未完成 Meego 条目上提供可访问的“开始 Agent 干活”入口，并在启动前展示可编辑任务说明、已注册仓库、Agent、可选模型和只读或隔离开发工作模式。

#### Scenario: 从 Meego 打开启动面板
- **WHEN** 用户点击未完成 Meego 条目的 Agent 按钮
- **THEN** 面板预填事项标题与来源，要求用户选择仓库和工作模式后才能提交

#### Scenario: 已完成事项不提供启动
- **WHEN** Todo 已完成、等待他人或 Meego 已完成
- **THEN** 工作台不提供可提交的 Agent 启动动作

#### Scenario: 不填写模型
- **WHEN** 用户选择 Agent 但将模型输入留空
- **THEN** 启动请求将模型保存为 `null` 并明确使用对应 Agent 默认模型

### Requirement: Agent 会话工作台
Loop SHALL 使用会话列表、对话区域和工作上下文区域展示真实 Agent Session；用户 SHALL 能查看当前状态、来源、仓库、工作区、分支、消息、命令与文件修改摘要。会话选择项与所在面板 SHALL 保持一致宽度，对话区域 SHALL 按发生时间在同一时间线内交错展示消息、命令、文件修改与 Turn 异常。

#### Scenario: 查看运行中会话
- **WHEN** Agent Turn 正在产生流式事件
- **THEN** Loop 实时更新会话状态与有界事件投影，无需整页刷新

#### Scenario: 按实际顺序查看 Agent 执行过程
- **WHEN** 一次 Turn 依次产生用户消息、工具调用和 Agent 回复
- **THEN** Loop 按时间顺序交错展示这些内容，而不是将全部工具调用追加到消息之后

### Requirement: 会话对话与确认交互
Loop SHALL 允许用户向空闲或运行中会话发送后续消息、回答 pending Confirmation、停止 Turn 和验收结果，并 SHALL 在失败时保留已输入内容和展示错误。

#### Scenario: 回答人工确认
- **WHEN** 用户选择确认选项并提交成功
- **THEN** UI 将确认显示为已回答并在同一会话中展示由答案创建的后续消息

### Requirement: 仓库配置界面
Settings SHALL 允许用户注册、查看和移除 Git 仓库或普通目录记录，展示规范路径、目录类型与可用 Git 元数据；移除注册 MUST NOT 删除磁盘内容或活跃会话工作区。启动面板为普通目录选择项 MUST 禁用隔离开发模式。

#### Scenario: 注册仓库
- **WHEN** 用户提交有效 Git 仓库路径
- **THEN** Settings 展示仓库名称、规范路径和当前分支，并可在 Agent 启动面板选择

#### Scenario: 选择普通目录
- **WHEN** 用户在启动面板选择已注册普通目录
- **THEN** 面板只允许提交只读分析，并明确说明 worktree 仅适用于 Git 仓库
