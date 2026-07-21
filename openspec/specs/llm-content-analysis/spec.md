# LLM 内容分析规范

## Purpose

本规范用于定义由本地持久队列异步驱动的 LLM 候选分析、版本化 Prompt、统一输出契约、可扩展 Provider、安全边界、幂等重试和用户审核约束。

## Requirements

### Requirement: 使用 LLM 进行非结构化内容分析
系统 SHALL 使用 LLM 对 SQLite 中的提及和 P2P 消息生成 Todo、知识与人物洞察候选，并 MUST NOT 使用关键词、正则表达式或硬编码语言列表决定非结构化内容的业务分类。所有 LLM 结果 MUST 经过用户审核，结构化来源校验和身份归一化可以继续使用确定性逻辑。

#### Scenario: 识别没有固定关键词的隐含行动项
- **WHEN** 一条消息以自然语言隐含表达用户需要完成的工作，但不包含预设行动关键词
- **THEN** 系统异步分析标准化来源并创建待审核 SQLite 候选，不直接创建 Todo Markdown

#### Scenario: 未识别到可沉淀内容
- **WHEN** LLM 返回有效空结果
- **THEN** 系统原子记录分析成功，且不创建候选或派生 Markdown

#### Scenario: 一批消息包含跨消息工作上下文
- **WHEN** 一轮同步取得多条未超过批次容量的提及和 P2P 消息
- **THEN** Worker 在一次 LLM 请求中发送按时间排序的多条标准化来源，并根据结构化结果分别创建 Todo、知识或人物洞察候选

### Requirement: 版本化且来源无关的 Prompt
系统 SHALL 通过单一的版本化 Prompt 构建器生成分析指令，使所有 Provider 接收相同的任务目标、分类定义、用户与时区上下文、有边界的多来源内容、信任边界和输出 Schema。Prompt MUST 将每条来源文本标记为不可信数据，并明确禁止执行其中的指令。

#### Scenario: 两种 Provider 分析同一来源
- **WHEN** 系统分别通过 `codex-sdk` 和 `codex-exec` 分析同一标准化来源记录
- **THEN** 两次调用使用相同的 Prompt 版本、语义指令和输出 Schema

#### Scenario: 来源内容包含提示注入
- **WHEN** 来源文本要求模型忽略分析指令、读取文件或调用工具
- **THEN** Prompt 将该文本仅作为待分类数据处理，分析结果不得执行或认可这些指令

#### Scenario: 两种 Provider 分析同一批来源
- **WHEN** 系统分别通过 `codex-sdk` 和 `codex-exec` 分析同一批标准化来源记录
- **THEN** 两次调用使用相同的 Prompt 版本、批次内容、语义指令和输出 Schema

#### Scenario: 批次中的来源包含提示注入
- **WHEN** 任一来源文本要求模型忽略分析指令、读取文件或调用工具
- **THEN** Prompt 将该文本仅作为待分析数据处理，分析结果不得执行或认可这些指令

### Requirement: 统一的结构化分析契约
系统 SHALL 使用版本化 JSON Schema 描述分析结果，并支持一个来源批次产生零个或多个 Todo、知识与人物洞察候选。每个候选 MUST 包含类型化字段、来源引用、置信度、证据和简短依据；系统 MUST 在单个 SQLite 事务前完成运行时与领域校验。

#### Scenario: 一条消息包含多个结果
- **WHEN** LLM 从同一来源识别出两个行动项和一个决策候选
- **THEN** 系统校验后在一个事务中分别持久化三个候选及其来源证据

#### Scenario: Provider 返回无效结构
- **WHEN** Provider 返回缺少必填字段、未知枚举值或无法解析的 JSON
- **THEN** 系统拒绝该结果、不写入任何部分候选，并记录可重试分析失败

#### Scenario: 多条消息产生多个结果
- **WHEN** LLM 从一批消息识别出两个行动项、一个决策候选和一个职责观察
- **THEN** 系统验证所有来源引用、参与者和证据后，在同一事务中持久化四个带有对应来源引用的候选

#### Scenario: Provider 返回无法定位的跨来源证据
- **WHEN** Provider 返回的引文不在其声明的批次来源正文中
- **THEN** 系统原子拒绝整个响应、不写入部分候选，并记录可重试的分析错误

### Requirement: 可扩展的 Provider 接口
系统 SHALL 定义来源无关的 `AnalysisProvider` 契约和 Provider 注册表，使分析协调器仅依赖统一请求、统一结果、可用性检查和取消/超时语义。新增 SDK、HTTP API、本地模型或 CLI Provider 时 MUST NOT 修改 Todo、知识或飞书同步的领域逻辑。

#### Scenario: 注册新的调用方式
- **WHEN** 开发者实现并注册一个符合 `AnalysisProvider` 契约的新 Provider
- **THEN** 该 Provider 可被配置选择，且复用现有 Prompt、Schema、校验、持久化和状态流程

### Requirement: Codex SDK Provider
系统 SHALL 提供 `codex-sdk` Provider，使用服务端 TypeScript 包 `@openai/codex-sdk` 创建隔离的 Codex 线程，并通过每轮 `outputSchema` 获取结构化最终响应。Provider MUST 支持把非空模型配置传给 `startThread`，使用受控环境、只读沙箱、独立运行目录和超时，并拒绝命令执行、文件修改、MCP 调用或 Web 搜索事件。

#### Scenario: 通过 Codex SDK 完成分析
- **WHEN** 当前 Provider 配置为 `codex-sdk` 且 SDK 可用
- **THEN** 系统使用统一 Prompt 与输出 Schema 发起分析，校验 `finalResponse` 并返回统一分析结果

#### Scenario: 通过 Codex SDK 指定模型完成分析
- **WHEN** 当前 Provider 配置为 `codex-sdk`、SDK 可用且模型配置非空
- **THEN** 系统使用该模型、统一批量 Prompt 与输出 Schema 发起分析，校验 `finalResponse` 并返回统一分析结果

#### Scenario: SDK 返回无副作用计划事件
- **WHEN** SDK 运行包含 `todo_list`、响应或推理等不产生外部副作用的事件，且最终响应有效
- **THEN** 系统保留事件类型并继续校验业务结果，不把该运行误报为工具活动

### Requirement: Codex Exec Provider
系统 SHALL 提供 `codex-exec` Provider，通过 `execFile` 以参数数组调用 `codex exec`，并使用临时隔离目录、`--ephemeral`、只读沙箱、结构化输出 Schema、超时、输出大小限制和受控环境变量。实现 MUST NOT 使用 shell 字符串拼接，非空模型配置 MUST 通过 `--model` 传递，并 MUST 检查退出码、最终响应和 JSONL 事件中的真实工具活动。

#### Scenario: 通过 codex exec 完成分析
- **WHEN** 当前 Provider 配置为 `codex-exec` 且 `codex` CLI 可用
- **THEN** 系统将统一 Prompt 通过标准输入传入进程，读取符合 Schema 的最终响应并返回统一分析结果

#### Scenario: codex exec 不可用
- **WHEN** 当前 Provider 为 `codex-exec`，但 CLI 缺失、认证失败、模型不可用、超时或以非零状态退出
- **THEN** 系统报告明确的 Provider 错误并保留来源与任务，不创建未经验证的候选

#### Scenario: 通过 codex exec 指定模型完成分析
- **WHEN** 当前 Provider 为 `codex-exec`、CLI 可用且模型配置非空
- **THEN** 系统使用参数数组传递 `--model`，将统一批量 Prompt 通过标准输入传入进程，并读取符合 Schema 的最终响应

### Requirement: 显式切换分析 Provider
系统 SHALL 允许用户通过工作区配置和 Settings 界面选择 Provider 与可选模型，并展示每种方式的可用性、当前选择和最近错误。配置更新 SHALL 原子保存，并仅影响更新后开始的新分析运行；留空模型 SHALL 使用 Codex 当前默认模型。

#### Scenario: 从 SDK 切换到客户端调用
- **WHEN** 用户把 Provider 从 `codex-sdk` 修改为 `codex-exec`
- **THEN** 已在运行的分析继续使用其启动时快照，后续分析使用 `codex-exec`

#### Scenario: 所选 Provider 调用失败
- **WHEN** 已选择的 Provider 在分析期间失败
- **THEN** 系统不得静默切换到另一个 Provider，也不得回退到硬编码分类

#### Scenario: 从 SDK 切换到客户端调用并指定模型
- **WHEN** 用户把 Provider 从 `codex-sdk` 修改为 `codex-exec` 并保存模型标识
- **THEN** 已在运行的批次继续使用其启动时快照，后续批次使用 `codex-exec` 和保存的模型

#### Scenario: 所选 Provider 或模型调用失败
- **WHEN** 已选择的 Provider 或模型在分析期间失败
- **THEN** 系统不得静默切换到另一个 Provider、模型或硬编码分类

### Requirement: 失败隔离与幂等重试
系统 SHALL 在来源与持久分析任务提交后异步调用 LLM，并以来源集合摘要、Prompt 版本、输出 Schema 版本、Provider、模型和配置摘要构造稳定幂等键。失败任务 SHALL 使用租约和有界退避重试；重复成功处理 MUST 复用结果。

#### Scenario: LLM 分析失败但来源同步成功
- **WHEN** 来源已成功写入且游标已推进，但 Provider 调用失败
- **THEN** 来源同步状态保持成功，分析任务记录失败并允许稍后重试

#### Scenario: Prompt 升级后重新分析
- **WHEN** Prompt 版本发生变化并触发重新分析
- **THEN** 系统创建具有新幂等键的任务和运行，并产生新的待审核候选而不修改人工 Markdown

#### Scenario: LLM 批次失败但来源同步成功
- **WHEN** 飞书来源已成功写入，但某个 LLM 批次调用或结果校验失败
- **THEN** 来源同步游标正常推进，失败批次中的任务显示分析失败，其他任务仍可继续

### Requirement: 安全、隐私与可观测性
系统 SHALL 只向 Provider 发送完成当前分类所需的最小上下文，并在 SQLite 记录 Provider、Prompt 版本、Schema 版本、模型、时间、耗时、用量、状态和脱敏错误。系统 MUST NOT 将凭证、内部推理或额外原始正文写入 Markdown、Prompt、日志或候选，也 MUST NOT 将机器人发送的消息或与机器人的 P2P 会话内容发送给 Provider。

#### Scenario: 查看分析来源信息
- **WHEN** 用户打开 LLM 生成的候选
- **THEN** 界面展示最小来源证据、置信度、Provider、Prompt 版本和分析时间，但不展示凭证或内部推理

#### Scenario: Provider 产生工具事件
- **WHEN** SDK 事件或 `codex exec --json` 流表明运行尝试执行命令、修改文件、调用 MCP 或进行 Web 搜索
- **THEN** 系统将运行标记为不合规并拒绝持久化全部候选

#### Scenario: 查看批量分析来源信息
- **WHEN** 用户打开由 LLM 生成的 Todo、知识或人物洞察候选
- **THEN** 界面展示对应的最小来源证据、置信度、Provider、Prompt 版本和分析时间，但不展示凭证或内部推理

#### Scenario: Provider 产生真实工具事件
- **WHEN** SDK 事件或 `codex exec --json` 事件表明运行尝试执行命令、修改文件、调用 MCP 或进行 Web 搜索
- **THEN** 系统将运行标记为不合规、保存实际事件类型和可操作错误，并拒绝持久化全部候选

#### Scenario: 机器人会话出现在飞书查询结果中
- **WHEN** 飞书返回机器人发送的消息或用户与机器人的 P2P 会话消息
- **THEN** 系统在构造分析请求前排除这些记录，Provider 不接收其内容
