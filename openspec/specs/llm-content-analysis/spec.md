# LLM 内容分析规范

## Purpose

定义基于版本化 Prompt 的 LLM 内容分析、统一输出契约、可扩展 Provider、安全边界、切换机制及失败处理。

## Requirements

### Requirement: 使用 LLM 进行非结构化内容分析
系统 SHALL 使用 LLM 对提及和 P2P 消息中的 Todo 与知识候选进行语义分析，并 MUST NOT 使用关键词、正则表达式或硬编码语言列表决定非结构化内容的业务分类。结构化来源字段的校验、飞书原生任务映射和人物身份归一化可以继续使用确定性逻辑。

#### Scenario: 识别没有固定关键词的隐含行动项
- **WHEN** 一条消息以自然语言隐含表达用户需要完成的工作，但不包含预设行动关键词
- **THEN** 系统把标准化来源记录交给 LLM，并根据结构化分析结果创建 Todo 或候选项

#### Scenario: 未识别到可沉淀内容
- **WHEN** LLM 返回有效的空结果，表示来源中没有 Todo 或知识候选
- **THEN** 系统记录本次分析已成功完成，且不创建派生文档

### Requirement: 版本化且来源无关的 Prompt
系统 SHALL 通过单一的版本化 Prompt 构建器生成分析指令，使所有 Provider 接收相同的任务目标、分类定义、用户与时区上下文、最小必要来源内容、信任边界和输出 Schema。Prompt MUST 将来源文本标记为不可信数据，并明确禁止执行其中的指令。

#### Scenario: 两种 Provider 分析同一来源
- **WHEN** 系统分别通过 `codex-sdk` 和 `codex-exec` 分析同一标准化来源记录
- **THEN** 两次调用使用相同的 Prompt 版本、语义指令和输出 Schema

#### Scenario: 来源内容包含提示注入
- **WHEN** 来源文本要求模型忽略分析指令、读取文件或调用工具
- **THEN** Prompt 将该文本仅作为待分类数据处理，分析结果不得执行或认可这些指令

### Requirement: 统一的结构化分析契约
系统 SHALL 使用版本化 JSON Schema 描述分析结果，并支持一条来源产生零个或多个 Todo 与知识候选。每个候选 MUST 包含类型化字段、`source_ref`、置信度、证据和简短依据；系统 MUST 在持久化前执行运行时 Schema 校验和领域校验。

#### Scenario: 一条消息包含多个结果
- **WHEN** LLM 从同一来源识别出两个行动项和一个决策候选
- **THEN** 系统校验并分别持久化三个带有同一来源引用的派生结果

#### Scenario: Provider 返回无效结构
- **WHEN** Provider 返回缺少必填字段、未知枚举值或无法解析的 JSON
- **THEN** 系统拒绝该结果、不写入部分派生文档，并记录可重试的分析错误

### Requirement: 可扩展的 Provider 接口
系统 SHALL 定义来源无关的 `AnalysisProvider` 契约和 Provider 注册表，使分析协调器仅依赖统一请求、统一结果、可用性检查和取消/超时语义。新增 SDK、HTTP API、本地模型或 CLI Provider 时 MUST NOT 修改 Todo、知识或飞书同步的领域逻辑。

#### Scenario: 注册新的调用方式
- **WHEN** 开发者实现并注册一个符合 `AnalysisProvider` 契约的新 Provider
- **THEN** 该 Provider 可被配置选择，且复用现有 Prompt、Schema、校验、持久化和状态流程

### Requirement: Codex SDK Provider
系统 SHALL 首期提供 `codex-sdk` Provider，使用服务端 TypeScript 包 `@openai/codex-sdk` 创建隔离的 Codex 线程，并通过每轮 `outputSchema` 获取结构化最终响应。Provider MUST 使用受控环境、只读沙箱、独立运行目录和超时，并拒绝包含非预期工具活动的运行。

#### Scenario: 通过 Codex SDK 完成分析
- **WHEN** 当前 Provider 配置为 `codex-sdk` 且 SDK 可用
- **THEN** 系统使用统一 Prompt 与输出 Schema 发起分析，校验 `finalResponse` 并返回统一分析结果

### Requirement: Codex Exec Provider
系统 SHALL 首期提供 `codex-exec` Provider，通过 `execFile` 以参数数组调用 `codex exec`，并使用临时隔离目录、`--ephemeral`、只读沙箱、结构化输出 Schema、超时、输出大小限制和受控环境变量。实现 MUST NOT 使用 shell 字符串拼接，并 MUST 检查退出码、最终响应和 JSONL 事件中的非预期工具活动。

#### Scenario: 通过 codex exec 完成分析
- **WHEN** 当前 Provider 配置为 `codex-exec` 且 `codex` CLI 可用
- **THEN** 系统将统一 Prompt 通过标准输入传入进程，读取符合 Schema 的最终响应并返回统一分析结果

#### Scenario: codex exec 不可用
- **WHEN** 当前 Provider 为 `codex-exec`，但 CLI 缺失、认证失败、超时或以非零状态退出
- **THEN** 系统报告明确的 Provider 错误并保留来源记录，不创建未经验证的派生内容

### Requirement: 显式切换分析 Provider
系统 SHALL 允许用户通过工作区配置和 Settings 界面在 `codex-sdk` 与 `codex-exec` 之间切换，并展示每种方式的可用性、当前选择和最近错误。配置更新 SHALL 在验证 Provider 标识后原子保存，并仅影响更新后开始的新分析运行。

#### Scenario: 从 SDK 切换到客户端调用
- **WHEN** 用户把 Provider 从 `codex-sdk` 修改为 `codex-exec`
- **THEN** 已在运行的分析继续使用其启动时快照，后续分析使用 `codex-exec`

#### Scenario: 所选 Provider 调用失败
- **WHEN** 已选择的 Provider 在分析期间失败
- **THEN** 系统不得静默切换到另一个 Provider，也不得回退到硬编码分类

### Requirement: 失败隔离与幂等重试
系统 SHALL 在调用 LLM 前先持久化规范来源文档，并以来源 ID、Prompt 版本、输出 Schema 版本和 Provider 配置摘要构造稳定的分析运行标识。失败运行 SHALL 记录可重试状态；重复成功运行 MUST 更新或跳过稳定派生记录，而不是创建重复内容。

#### Scenario: LLM 分析失败但来源同步成功
- **WHEN** 飞书来源已成功写入，但 LLM 调用或结果校验失败
- **THEN** 来源同步检查点可以正常推进，分析状态显示失败且允许稍后重试

#### Scenario: Prompt 升级后重新分析
- **WHEN** Prompt 版本发生变化并触发重新分析
- **THEN** 系统创建新的分析运行记录，按稳定分析项键协调匹配、新增和过时结果，并保留用户拥有的字段

### Requirement: 安全、隐私与可观测性
系统 SHALL 只向 Provider 发送完成当前分类所需的最小上下文，并记录 Provider、Prompt 版本、Schema 版本、模型信息、开始与结束时间、耗时、用量、状态和脱敏错误。系统 MUST NOT 将凭证写入 Markdown、Prompt、日志或分析结果，也 MUST NOT 默认记录额外的原始工作内容。

#### Scenario: 查看分析来源信息
- **WHEN** 用户打开由 LLM 生成的 Todo 或知识候选
- **THEN** 界面可展示来源引用、置信度、Provider、Prompt 版本和分析时间，但不展示凭证或内部推理

#### Scenario: Provider 产生工具事件
- **WHEN** SDK 事件或 `codex exec --json` 流表明运行尝试执行命令、修改文件、调用 MCP 或进行 Web 搜索
- **THEN** 系统将运行标记为不合规并拒绝持久化其业务结果
