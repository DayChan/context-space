## MODIFIED Requirements

### Requirement: 使用 LLM 进行非结构化内容分析
系统 SHALL 使用 LLM 对一轮同步中已持久化的提及和 P2P 消息进行批量语义分析，从中生成 Todo、知识候选和人物洞察，并 MUST NOT 使用关键词、正则表达式或硬编码语言列表决定非结构化内容的业务分类。结构化来源字段的校验、飞书原生任务映射、批次容量控制、输出安全校验和人物身份归一化可以继续使用确定性逻辑。

#### Scenario: 一批消息包含跨消息工作上下文
- **WHEN** 一轮同步取得多条未超过批次容量的提及和 P2P 消息
- **THEN** 系统在一次 LLM 请求中发送按时间排序的多条标准化来源，并根据结构化结果分别创建 Todo、知识候选或人物洞察

#### Scenario: 未识别到可沉淀内容
- **WHEN** LLM 返回有效的空结果，表示整批来源中没有 Todo、知识候选或人物洞察
- **THEN** 系统记录本次批量分析已成功完成，且不创建派生文档

### Requirement: 版本化且来源无关的 Prompt
系统 SHALL 通过单一的版本化 Prompt 构建器生成分析指令，使所有 Provider 接收相同的任务目标、分类定义、用户与时区上下文、有边界的多来源内容、信任边界和输出 Schema。Prompt MUST 将每条来源文本标记为不可信数据，并明确禁止执行其中的指令。

#### Scenario: 两种 Provider 分析同一批来源
- **WHEN** 系统分别通过 `codex-sdk` 和 `codex-exec` 分析同一批标准化来源记录
- **THEN** 两次调用使用相同的 Prompt 版本、批次内容、语义指令和输出 Schema

#### Scenario: 批次中的来源包含提示注入
- **WHEN** 任一来源文本要求模型忽略分析指令、读取文件或调用工具
- **THEN** Prompt 将该文本仅作为待分析数据处理，分析结果不得执行或认可这些指令

### Requirement: 统一的结构化分析契约
系统 SHALL 使用版本化 JSON Schema 描述批量分析结果，并支持一个批次产生零个或多个 Todo、知识候选和人物洞察。每个结果 MUST 包含类型化字段、一个或多个 `source_refs`、置信度、带来源的逐字证据和简短依据；系统 MUST 在任何派生写入前对整个响应执行运行时 Schema 校验和领域校验。

#### Scenario: 多条消息产生多个结果
- **WHEN** LLM 从一批消息识别出两个行动项、一个决策候选和一个职责观察
- **THEN** 系统验证所有来源引用、参与者和证据后，分别持久化四个带有对应来源引用的结果

#### Scenario: Provider 返回无法定位的跨来源证据
- **WHEN** Provider 返回的引文不在其声明的批次来源正文中
- **THEN** 系统原子拒绝整个响应、不写入部分派生文档，并记录可重试的分析错误

### Requirement: Codex SDK Provider
系统 SHALL 提供 `codex-sdk` Provider，使用服务端 TypeScript 包 `@openai/codex-sdk` 创建隔离的 Codex 线程，并通过每轮 `outputSchema` 获取结构化最终响应。Provider MUST 支持把非空模型配置传给 `startThread`，使用受控环境、只读沙箱、独立运行目录和超时，并拒绝命令执行、文件修改、MCP 调用或 Web 搜索事件。

#### Scenario: 通过 Codex SDK 指定模型完成分析
- **WHEN** 当前 Provider 配置为 `codex-sdk`、SDK 可用且模型配置非空
- **THEN** 系统使用该模型、统一批量 Prompt 与输出 Schema 发起分析，校验 `finalResponse` 并返回统一分析结果

#### Scenario: SDK 返回无副作用计划事件
- **WHEN** SDK 运行包含 `todo_list`、响应或推理等不产生外部副作用的事件，且最终响应有效
- **THEN** 系统保留事件类型并继续校验业务结果，不把该运行误报为工具活动

### Requirement: Codex Exec Provider
系统 SHALL 提供 `codex-exec` Provider，通过 `execFile` 以参数数组调用 `codex exec`，并使用临时隔离目录、`--ephemeral`、只读沙箱、结构化输出 Schema、超时、输出大小限制和受控环境变量。实现 MUST NOT 使用 shell 字符串拼接，非空模型配置 MUST 通过 `--model` 传递，并 MUST 检查退出码、最终响应和 JSONL 事件中的真实工具活动。

#### Scenario: 通过 codex exec 指定模型完成分析
- **WHEN** 当前 Provider 为 `codex-exec`、CLI 可用且模型配置非空
- **THEN** 系统使用参数数组传递 `--model`，将统一批量 Prompt 通过标准输入传入进程，并读取符合 Schema 的最终响应

#### Scenario: codex exec 不可用
- **WHEN** 当前 Provider 为 `codex-exec`，但 CLI 缺失、认证失败、模型不可用、超时或以非零状态退出
- **THEN** 系统报告明确的 Provider 错误并保留来源记录，不创建未经验证的派生内容

### Requirement: 显式切换分析 Provider
系统 SHALL 允许用户通过工作区配置和 Settings 界面选择 Provider 与可选模型，并展示每种方式的可用性、当前选择和最近错误。配置更新 SHALL 原子保存，并仅影响更新后开始的新分析运行；留空模型 SHALL 使用 Codex 当前默认模型。

#### Scenario: 从 SDK 切换到客户端调用并指定模型
- **WHEN** 用户把 Provider 从 `codex-sdk` 修改为 `codex-exec` 并保存模型标识
- **THEN** 已在运行的批次继续使用其启动时快照，后续批次使用 `codex-exec` 和保存的模型

#### Scenario: 所选 Provider 或模型调用失败
- **WHEN** 已选择的 Provider 或模型在分析期间失败
- **THEN** 系统不得静默切换到另一个 Provider、模型或硬编码分类

### Requirement: 失败隔离与幂等重试
系统 SHALL 在调用 LLM 前先持久化全部规范来源文档，并以有序来源 ID、来源内容摘要、Prompt 版本、输出 Schema 版本和 Provider 配置摘要构造稳定的批量分析运行标识。失败批次 SHALL 记录可重试状态；完全相同的重复成功批次 MUST 更新或跳过稳定派生记录，而不是创建重复内容。

#### Scenario: LLM 批次失败但来源同步成功
- **WHEN** 飞书来源已成功写入，但某个 LLM 批次调用或结果校验失败
- **THEN** 来源同步检查点正常推进，失败批次中的来源显示分析失败，其他批次仍可继续

#### Scenario: Prompt 升级后重新分析
- **WHEN** Prompt 版本发生变化并触发一组来源重新分析
- **THEN** 系统创建新的批量分析运行记录，按稳定分析项和人物洞察键协调匹配、新增和过时结果，并保留用户拥有的字段

### Requirement: 安全、隐私与可观测性
系统 SHALL 在配置的容量上限内向 Provider 发送完成批量分析所需的上下文，并记录批次来源引用、Provider、Prompt 版本、Schema 版本、模型信息、开始与结束时间、耗时、用量、事件类型、状态和脱敏错误。系统 MUST NOT 将凭证写入 Markdown、Prompt、日志或分析结果，也 MUST NOT 默认记录额外的原始工作内容。

#### Scenario: 查看批量分析来源信息
- **WHEN** 用户打开由 LLM 生成的 Todo、知识候选或人物观察
- **THEN** 界面可展示对应来源引用、置信度、Provider、Prompt 版本和分析时间，但不展示凭证或内部推理

#### Scenario: Provider 产生真实工具事件
- **WHEN** SDK 项目或 `codex exec --json` 事件表明运行尝试执行命令、修改文件、调用 MCP 或进行 Web 搜索
- **THEN** 系统将运行标记为不合规、保存实际事件类型和可操作错误，并拒绝持久化其业务结果
