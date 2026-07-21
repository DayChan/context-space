## MODIFIED Requirements

### Requirement: 可见的 Loop 界面
UI SHALL 包含 Loop 主导航项、Now 就绪度摘要以及人工 Agent 会话工作台；Loop SHALL 明确区分人工启动能力和仍被禁用的自动触发能力。

#### Scenario: 打开人工 Loop
- **WHEN** 用户访问 Loop 路由
- **THEN** 页面展示 Agent 会话、对话和注意力分类，并明确说明系统不会自动启动事项

### Requirement: 就绪度分类
Loop 页面 SHALL 展示正在执行、需要人工确认、等待用户回复、待验收和最近结束的 Agent 会话；未来自动化 readiness MAY 作为独立摘要保留，但 MUST NOT 与真实运行记录混合。

#### Scenario: Agent 请求确认
- **WHEN** 一个真实 Agent 会话包含 pending Confirmation Request
- **THEN** 该会话出现在“需要人工确认”区域，并展示对应真实运行记录

### Requirement: V1 不具备执行能力
V1 SHALL 允许用户从符合条件的 Todo 或未完成 Meego 条目显式启动受限 Agent 会话；V1 MUST NOT 暴露调度器、同步后自动启动、基于 Todo 自动化元数据的自动执行或无人值守外部动作。

#### Scenario: 人工启动会话
- **WHEN** 用户在启动面板确认来源、任务说明、仓库和工作模式
- **THEN** 系统创建一个可审计的人工 Agent 会话

#### Scenario: 没有用户操作的事项更新
- **WHEN** Todo 优先级、同步来源或自动化元数据发生变化但用户没有提交启动请求
- **THEN** 系统不创建或运行 Agent 会话
