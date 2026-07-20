## MODIFIED Requirements

### Requirement: 分类知识文档
系统 SHALL 支持项目、决策、操作手册、概念、术语表和草稿类人工知识 Markdown，并为其提供稳定 ID 和来源引用；分析识别的知识 MUST 先保存为 SQLite 候选。

#### Scenario: 捕获决策候选
- **WHEN** 分析在来源上下文中识别到可能的决策
- **THEN** 系统创建包含决策元数据和证据的待审核候选，不直接创建知识 Markdown

### Requirement: 来源依据与置信度
知识候选 MUST 展示来源引用、置信度、生成时间和审核状态；接受后创建的知识 Markdown SHALL 记录候选 ID 和用户确认的最小证据。

#### Scenario: 查看生成的知识
- **WHEN** 用户打开一条未审核知识候选
- **THEN** 页面展示其最小证据、置信度和审核操作，且不会将其混同为人工知识文档

### Requirement: 工作摘要
系统 SHALL 根据人工 Todo 与知识 Markdown、SQLite 日历与提及、上游任务、等待事项和候选状态构建 Now 视图，并支持生成带日期的人工摘要。

#### Scenario: 构建 Now 摘要
- **WHEN** SQLite 机器数据和 Markdown 索引均已就绪
- **THEN** Now 视图组合当前重要 Todo、近期日历、最近提及、等待事项、待审核候选和知识变更

### Requirement: 知识搜索与反向链接
系统 SHALL 使人工知识内容可搜索，并通过稳定引用展示来自 Todo、人物、机器来源和其他知识文档的传入链接；原始来源正文到期删除 MUST NOT 破坏引用身份。

#### Scenario: 搜索项目术语
- **WHEN** 用户搜索项目页面中包含的术语
- **THEN** 系统从 SQLite Markdown 索引投影返回匹配知识文档及其类型和相关元数据
