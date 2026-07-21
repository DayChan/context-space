## ADDED Requirements

### Requirement: 结构化事件信封
系统 SHALL 将每条日志序列化为单行 JSON，并至少包含 UTC `timestamp`、`level`、`service`、`event` 和 `pid`。系统 MUST 支持 `trace`、`debug`、`info`、`warn`、`error`、`fatal` 与 `silent` 等级，并在序列化前执行等级过滤。

#### Scenario: 输出一条业务事件
- **WHEN** 模块以 `info` 记录事件及结构化字段
- **THEN** 终端和已启用的文件目标收到字段一致且可独立解析的一行 JSON

#### Scenario: 过滤低等级事件
- **WHEN** 当前日志等级为 `warn` 且模块记录 `debug` 或 `info` 事件
- **THEN** 系统不向任何目标输出这些事件

### Requirement: 终端与轮转文件输出
系统 SHALL 支持独立开关的终端和文件目标。文件目标 SHALL 默认写入 `<workspace>/.context/logs/`，按 UTC 日期和配置的最大文件大小轮转，并 SHALL 只清理超过配置保留期且匹配应用日志命名规则的文件。

#### Scenario: 日期内按大小轮转
- **WHEN** 当前日期日志文件加入下一条日志后将超过大小上限
- **THEN** 系统把该条日志写入同日期的下一个递增分段文件

#### Scenario: 清理过期日志
- **WHEN** Logger 启动或跨越 UTC 日期且目录中存在超过保留期的应用日志
- **THEN** 系统删除过期应用日志并保留未过期日志和不匹配命名规则的文件

#### Scenario: 测试环境默认静默
- **WHEN** 进程运行于测试环境且没有显式启用日志目标
- **THEN** 系统不写终端或文件，同时 Logger API 仍可正常调用

### Requirement: 可配置与可关闭
系统 SHALL 从环境变量读取日志等级、终端开关、文件开关、目录、单文件大小和保留天数。系统 MUST 为无效或越界配置使用安全默认值，并 SHALL 提供等待待写事件完成的 `flush` 和 `close` 能力。

#### Scenario: 应用有效配置
- **WHEN** 启动环境提供合法的日志等级、目录、大小和保留期
- **THEN** Logger 使用这些值创建输出目标

#### Scenario: 无效配置降级
- **WHEN** 启动环境提供未知等级、非法布尔值或越界数字
- **THEN** 服务继续启动、对应选项使用安全默认值且系统记录不含敏感值的配置警告

#### Scenario: 关闭前刷新
- **WHEN** 服务收到正常停止信号
- **THEN** 系统记录停止事件并等待已排队日志完成后关闭

### Requirement: 跨异步边界关联
系统 SHALL 支持子 Logger 固定字段和基于异步上下文的关联字段。HTTP 请求、飞书同步与 LLM 分析 SHALL 分别携带稳定的 `request_id`、`sync_id`、`run_id` 和 `batch_id`，来源级事件在适用时 SHALL 携带 `source_id` 或来源类型。

#### Scenario: 请求内业务事件继承请求编号
- **WHEN** HTTP 请求触发同步或重分析且下游异步模块记录日志
- **THEN** 这些事件自动包含该请求的 `request_id`，并包含各自的同步或分析编号

#### Scenario: 并发上下文隔离
- **WHEN** 两个请求并发执行并记录异步事件
- **THEN** 每个事件只包含所属请求的关联编号，不发生串号

### Requirement: 隐私与凭证脱敏
系统 MUST 在写往任何目标前递归净化日志字段。系统 MUST 拒绝记录原始消息正文、Prompt、请求体、完整模型响应、标准输入输出、认证头、Cookie、密码、Secret 和访问令牌，并 MUST 对字符串中的常见凭证模式进行替换。系统 SHALL 限制字符串长度、集合大小、对象深度并安全处理循环引用。

#### Scenario: 敏感字段被拒绝
- **WHEN** 调用方意外提交 `authorization`、`cookie`、`prompt`、`body`、`stdin`、`stdout` 或 `final_response` 字段
- **THEN** 日志中的对应值为统一脱敏标记且原值不出现在序列化结果中

#### Scenario: 字符串中的凭证被替换
- **WHEN** 错误消息或堆栈含 Bearer Token、API Key 或 Codex 会话令牌
- **THEN** 所有输出目标只收到替换后的文本

#### Scenario: 保留安全的 Token 用量
- **WHEN** 分析成功并记录 `input_tokens`、`cached_input_tokens` 和 `output_tokens`
- **THEN** 系统保留这些数值而不因字段名包含 `tokens` 而误脱敏

### Requirement: HTTP 与服务生命周期日志
系统 SHALL 记录服务初始化、监听、正常停止、未捕获异常和未处理 Promise 拒绝。每个 HTTP 请求 SHALL 在响应完成或连接中断时记录方法、不含查询值的路径、状态码和耗时，并 SHALL 在响应头返回格式安全的 `x-request-id`。全局错误 SHALL 记录分类、脱敏消息和脱敏堆栈。

#### Scenario: HTTP 请求成功
- **WHEN** 客户端请求 API 并收到成功响应
- **THEN** 系统生成一次完成事件，其中包含请求编号、方法、路径、状态码和非负耗时，但不包含查询参数值或请求体

#### Scenario: HTTP 请求失败
- **WHEN** 路由抛出校验错误或未处理异常
- **THEN** 系统记录带相同请求编号的失败详情与完成事件，并保持现有 HTTP 错误响应语义

#### Scenario: 接受安全的外部请求编号
- **WHEN** 客户端提供符合长度和字符限制的 `x-request-id`
- **THEN** 系统复用该值；不符合限制时生成新的 UUID

### Requirement: 飞书同步与命令链路日志
系统 SHALL 记录飞书同步开始和结束、每个来源及时间窗口的开始和结果、接收与持久化数量、分析摘要和结构化 issue。`lark-cli` 事件 SHALL 记录命令族、参数名称、耗时、结果状态和输出大小，但 MUST 不记录完整参数载荷、stdout、stderr 或飞书响应正文。

#### Scenario: 来源同步成功
- **WHEN** 一个来源的所有窗口拉取并持久化成功
- **THEN** 日志可通过 `sync_id` 和来源类型还原窗口数量、接收数量、持久化数量与耗时

#### Scenario: 权限或参数错误
- **WHEN** `lark-cli` 返回权限、认证或字段校验问题
- **THEN** 系统记录 issue 类型、错误码、`log_id`、是否需要人工处理和脱敏错误，不记录原始命令输出

#### Scenario: 同步后批量分析失败
- **WHEN** 来源已成功落盘但后续 LLM 分析抛出异常
- **THEN** 系统记录同步编号、待分析记录数、失败分类和堆栈，并继续保留现有同步状态语义

### Requirement: LLM 批次与 Provider 诊断日志
系统 SHALL 记录 LLM 批次的选择、跳过、开始、Provider 可用性、调用完成、事件类型、usage、验证、衍生文档写入和最终失败。日志 SHALL 包含 `run_id`、`batch_id`、Provider、模型、来源数量、字符计数、结果数量和耗时，但 MUST 不包含 Prompt、来源正文或完整模型响应。Codex Exec 成功返回的非空 stderr 诊断 SHALL 经脱敏后作为独立事件持久化。

#### Scenario: 批次分析成功
- **WHEN** Provider 返回有效结构且衍生文档写入完成
- **THEN** 同一 `run_id` 下存在开始、Provider 完成、验证与写入完成事件，并包含安全计数、事件类型、usage 和耗时

#### Scenario: 相同成功运行被跳过
- **WHEN** 非强制分析命中已有成功运行
- **THEN** 系统记录跳过事件及 `run_id`，且不重复记录 Provider 调用开始

#### Scenario: Provider 返回诊断
- **WHEN** `codex exec` 成功完成但 stderr 含非空诊断
- **THEN** 系统记录脱敏且有限长度的 Provider 诊断事件，不把诊断写入规范分析 Markdown

#### Scenario: Provider 或校验失败
- **WHEN** Provider 不可用、超时、产生非法工具事件或返回无效输出
- **THEN** 系统记录错误码、脱敏异常、已知事件类型和耗时，并继续更新现有分析运行失败记录

### Requirement: 日志目标故障降级
系统 MUST 防止日志序列化或文件写入失败中断同步、分析或 HTTP 响应。文件目标首次失败时 SHALL 向 stderr 写入一条最小化、脱敏的应急事件，后续业务日志 SHALL 继续尝试其他已启用目标，且 SHALL 避免递归记录相同日志故障。

#### Scenario: 文件目录不可写
- **WHEN** 文件目标创建目录、轮转、清理或追加失败
- **THEN** 当前业务操作继续执行，终端目标仍可用且 stderr 至多输出受控的应急故障事件

#### Scenario: 日志字段无法正常序列化
- **WHEN** 日志字段包含循环引用、BigInt 或过深对象
- **THEN** 系统输出受限的安全表示而不向调用方抛出异常
