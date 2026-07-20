## MODIFIED Requirements

### Requirement: 稳定且来源无关的身份
系统 SHALL 在 SQLite 中创建稳定内部人物 ID，并将其与一个或多个提供方身份关联，不使用显示名称作为主键；人物身份记录本身 MUST NOT 自动创建人工备注 Markdown。

#### Scenario: 发现飞书参与者
- **WHEN** 之前未知的飞书 open ID 出现在相关上下文中
- **THEN** 系统在 SQLite 创建人物身份，后续再次出现时更新同一身份而不是创建重复人物 Markdown

### Requirement: 有证据支撑的档案内容
人物视图 SHALL 组合 SQLite 通讯录事实、人工 Markdown 备注和已接受人物洞察；新生成洞察 MUST 先作为带证据、置信度和时间的候选等待审核。

#### Scenario: 添加协作观察
- **WHEN** 分析根据已采集消息推断出工作协作偏好
- **THEN** 系统创建人物洞察候选，只有用户接受后才物化到人物备注 Markdown
