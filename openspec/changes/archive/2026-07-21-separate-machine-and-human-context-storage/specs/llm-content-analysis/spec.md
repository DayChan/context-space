## MODIFIED Requirements

### Requirement: 使用 LLM 进行非结构化内容分析
系统 SHALL 使用 LLM 对 SQLite 中的提及和 P2P 消息生成 Todo、知识与人物洞察候选，并 MUST NOT 使用关键词、正则表达式或硬编码语言列表决定非结构化内容的业务分类。所有 LLM 结果 MUST 经过用户审核，结构化来源校验和身份归一化可以继续使用确定性逻辑。

#### Scenario: 识别没有固定关键词的隐含行动项
- **WHEN** 一条消息以自然语言隐含表达用户需要完成的工作，但不包含预设行动关键词
- **THEN** 系统异步分析标准化来源并创建待审核 SQLite 候选，不直接创建 Todo Markdown

#### Scenario: 未识别到可沉淀内容
- **WHEN** LLM 返回有效空结果
- **THEN** 系统原子记录分析成功，且不创建候选或派生 Markdown

### Requirement: 统一的结构化分析契约
系统 SHALL 使用版本化 JSON Schema 描述分析结果，并支持一个来源批次产生零个或多个 Todo、知识与人物洞察候选。每个候选 MUST 包含类型化字段、来源引用、置信度、证据和简短依据；系统 MUST 在单个 SQLite 事务前完成运行时与领域校验。

#### Scenario: 一条消息包含多个结果
- **WHEN** LLM 从同一来源识别出两个行动项和一个决策候选
- **THEN** 系统校验后在一个事务中分别持久化三个候选及其来源证据

#### Scenario: Provider 返回无效结构
- **WHEN** Provider 返回缺少必填字段、未知枚举值或无法解析的 JSON
- **THEN** 系统拒绝该结果、不写入任何部分候选，并记录可重试分析失败

### Requirement: 失败隔离与幂等重试
系统 SHALL 在来源与持久分析任务提交后异步调用 LLM，并以来源集合摘要、Prompt 版本、输出 Schema 版本、Provider、模型和配置摘要构造稳定幂等键。失败任务 SHALL 使用租约和有界退避重试；重复成功处理 MUST 复用结果。

#### Scenario: LLM 分析失败但来源同步成功
- **WHEN** 来源已成功写入且游标已推进，但 Provider 调用失败
- **THEN** 来源同步状态保持成功，分析任务记录失败并允许稍后重试

#### Scenario: Prompt 升级后重新分析
- **WHEN** Prompt 版本发生变化并触发重新分析
- **THEN** 系统创建具有新幂等键的任务和运行，并产生新的待审核候选而不修改人工 Markdown

### Requirement: 安全、隐私与可观测性
系统 SHALL 只向 Provider 发送完成当前分类所需的最小上下文，并在 SQLite 记录 Provider、Prompt 版本、Schema 版本、模型、时间、耗时、用量、状态和脱敏错误。系统 MUST NOT 将凭证、内部推理或额外原始正文写入 Markdown、Prompt、日志或候选。

#### Scenario: 查看分析来源信息
- **WHEN** 用户打开 LLM 生成的候选
- **THEN** 界面展示最小来源证据、置信度、Provider、Prompt 版本和分析时间，但不展示凭证或内部推理

#### Scenario: Provider 产生工具事件
- **WHEN** SDK 事件或 `codex exec --json` 流表明运行尝试执行命令、修改文件、调用 MCP 或进行 Web 搜索
- **THEN** 系统将运行标记为不合规并拒绝持久化全部候选
