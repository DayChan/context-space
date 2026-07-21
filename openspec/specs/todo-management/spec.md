# Todo 管理规范

## Purpose

本规范用于区分 SQLite 上游任务、待审核行动项候选和用户拥有的 Todo Markdown，并定义人工 Todo 的生命周期、承诺方向、优先级、证据和默认禁用的自动化元数据。

## Requirements

### Requirement: Todo 来源处理
系统 SHALL 将飞书原生任务作为 SQLite 上游任务展示，并将非结构化上下文中的行动项保存为待审核候选；只有用户显式创建人工 Todo 或接受候选时才创建规范 Todo Markdown。

#### Scenario: 导入原生任务
- **WHEN** 同步到一条新的未完成飞书任务
- **THEN** 系统创建或更新唯一的 SQLite 上游任务，并在工作台展示其上游所有权

#### Scenario: 检测含糊的聊天行动项
- **WHEN** LLM 从聊天消息识别出行动项，无论置信度高低
- **THEN** 系统将其作为候选放入 Inbox，且不会在用户接受前显示为已确认 Todo

#### Scenario: 接受聊天行动项
- **WHEN** 用户审核并接受一条聊天行动项候选
- **THEN** 系统通过可恢复接受操作创建确定性人工 Todo Markdown

### Requirement: 生命周期与承诺方向
每个人工 Todo MUST 记录受支持的生命周期状态，并说明该事项由用户负责、正在等待他人，还是共同负责。用户 SHALL 能通过工作台把人工 Todo 标记为完成或重新打开；后续只读来源同步 MUST 保留人工 Markdown，且不得把 SQLite 上游任务状态写入人工 Todo。

#### Scenario: 跟踪等待他人的工作
- **WHEN** 一条已确认 Todo 的方向为 `waiting_on_them`
- **THEN** 该 Todo 出现在等待视图中，并从用户的直接执行队列中排除

#### Scenario: 标记 Todo 已完成
- **WHEN** 用户在工作台点击一条开放 Todo 的完成控件
- **THEN** 系统持久化完成状态并立即在界面中展示更新结果

#### Scenario: 同步后保留本地状态
- **WHEN** 用户已将人工 Todo 标记为完成，随后再次执行只读飞书同步
- **THEN** 系统保留该 Todo Markdown 的完成状态而不把它重置为开放

### Requirement: 可解释优先级
系统 SHALL 根据基础分以及紧迫度、明确指派、停滞和 Leader 参与等具名加权计算优先级，并优先采用用户设置的手动优先级。

#### Scenario: 应用 Leader 加权
- **WHEN** 一条开放的 `owed_by_me` Todo 引用了手动配置的 Leader
- **THEN** 该 Todo 的最终优先级提高，且结果中包含可见的 Leader 原因

#### Scenario: 保留手动优先级
- **WHEN** Todo 设置了手动优先级覆盖值
- **THEN** 排序使用手动值，同时保留自动计算原因用于解释

### Requirement: Todo 来源依据
每条由候选接受产生的 Todo SHALL 记录候选 ID 和可解析的稳定来源引用，并在 API 和 UI 中展示用户确认的最小证据。

#### Scenario: 打开 Todo 证据
- **WHEN** 用户查看由飞书提及候选接受而来的 Todo
- **THEN** Todo 展示候选 ID、来源元数据和审核时确认的最小证据，而不依赖原始正文永久存在

### Requirement: 自动化元数据
每条 Todo SHALL 提供自动化配置块，其默认模式为禁用。

#### Scenario: 创建新 Todo
- **WHEN** 创建 Todo 时未提供显式自动化设置
- **THEN** 其模式为 `disabled`、需要确认且不允许任何能力
