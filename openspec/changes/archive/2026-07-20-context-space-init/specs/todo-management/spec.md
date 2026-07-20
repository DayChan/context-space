## ADDED Requirements

### Requirement: Todo 来源处理
系统 SHALL 根据飞书原生任务创建权威 Todo，并根据非原生上下文创建可审核候选；如果明确行动项达到已配置的置信度阈值，则可直接创建 Todo。

#### Scenario: 导入原生任务
- **WHEN** 同步到一条新的未完成飞书任务
- **THEN** 系统创建或更新一条开放 Todo，并为其保留稳定的来源引用和上游状态所有权

#### Scenario: 检测含糊的聊天行动项
- **WHEN** 消息暗示存在工作，但未达到明确行动项阈值
- **THEN** 系统将候选项放入 Inbox，且不会把它显示为已确认的高优先级 Todo

### Requirement: 生命周期与承诺方向
每个 Todo MUST 记录受支持的生命周期状态，并说明该事项由用户负责、正在等待他人，还是共同负责。

#### Scenario: 跟踪等待他人的工作
- **WHEN** 一条已确认 Todo 的方向为 `waiting_on_them`
- **THEN** 该 Todo 出现在等待视图中，并从用户的直接执行队列中排除

### Requirement: 可解释优先级
系统 SHALL 根据基础分以及紧迫度、明确指派、停滞和 Leader 参与等具名加权计算优先级，并优先采用用户设置的手动优先级。

#### Scenario: 应用 Leader 加权
- **WHEN** 一条开放的 `owed_by_me` Todo 引用了手动配置的 Leader
- **THEN** 该 Todo 的最终优先级提高，且结果中包含可见的 Leader 原因

#### Scenario: 保留手动优先级
- **WHEN** Todo 设置了手动优先级覆盖值
- **THEN** 排序使用手动值，同时保留自动计算原因用于解释

### Requirement: Todo 来源依据
每条非手动 Todo SHALL 至少保留一个可解析的来源引用，并在 API 和 UI 中展示该引用。

#### Scenario: 打开 Todo 证据
- **WHEN** 用户查看由飞书提及派生的 Todo
- **THEN** Todo 展示指向已采集提及文档的引用

### Requirement: 自动化元数据
每条 Todo SHALL 提供自动化配置块，其默认模式为禁用。

#### Scenario: 创建新 Todo
- **WHEN** 创建 Todo 时未提供显式自动化设置
- **THEN** 其模式为 `disabled`、需要确认且不允许任何能力
