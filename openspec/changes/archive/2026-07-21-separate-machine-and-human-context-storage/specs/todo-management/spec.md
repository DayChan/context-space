## MODIFIED Requirements

### Requirement: Todo 来源处理
系统 SHALL 将飞书原生任务作为 SQLite 上游任务展示，并将非结构化上下文中的行动项保存为待审核候选；只有用户显式创建人工 Todo 或接受候选时才创建规范 Todo Markdown。

#### Scenario: 导入原生任务
- **WHEN** 同步到一条新的未完成飞书任务
- **THEN** 系统创建或更新唯一的 SQLite 上游任务，并在工作台展示其上游所有权

#### Scenario: 接受聊天行动项
- **WHEN** 用户审核并接受一条聊天行动项候选
- **THEN** 系统通过可恢复接受操作创建确定性人工 Todo Markdown

### Requirement: Todo 来源依据
每条由候选接受产生的 Todo SHALL 记录候选 ID 和可解析的稳定来源引用，并在 API 和 UI 中展示用户确认的最小证据。

#### Scenario: 打开 Todo 证据
- **WHEN** 用户查看由飞书提及候选接受而来的 Todo
- **THEN** Todo 展示候选 ID、来源元数据和审核时确认的最小证据，而不依赖原始正文永久存在
