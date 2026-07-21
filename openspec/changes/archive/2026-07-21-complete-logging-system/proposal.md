## Why

当前系统仅保留同步状态和 LLM 分析运行元数据，缺少可持续检索的请求日志、关键链路事件、异常堆栈与 Provider 诊断，导致同步或分析失败时难以还原完整过程。需要在不泄露飞书消息、Prompt 和凭证的前提下，建立统一、可关联、可轮转的本地日志能力。

## What Changes

- 新增统一的结构化日志组件，使用 JSON Lines 输出稳定字段、日志等级、时间戳、事件名和关联上下文。
- 同时支持标准输出与工作区内按日期、大小轮转的日志文件，并按配置清理过期文件。
- 为 HTTP 请求、服务启动与停止、全局异常、飞书同步、`lark-cli` 调用、LLM 批处理、Codex Provider 调用及衍生文档写入增加关键事件。
- 使用 `request_id`、`sync_id`、`run_id`、`batch_id` 和 `source_id` 串联跨模块调用链。
- 统一序列化异常信息并保存经过脱敏的堆栈与诊断摘要；成功调用产生的 `codex exec` stderr 诊断也可被持久化。
- 对字段名和字符串内容执行递归脱敏及长度限制，禁止记录原始消息正文、Prompt、模型完整响应、访问令牌、Cookie 和认证头。
- 增加环境变量配置、关闭与刷新机制、日志系统自身故障降级，以及面向轮转、脱敏、请求关联和关键业务链路的自动化测试。
- 在 README 中补充日志目录、配置项、常用查询方式和隐私边界。

## Capabilities

### New Capabilities

- `structured-logging`: 定义结构化日志格式、输出目标、轮转保留、关联上下文、脱敏、错误降级和关键链路可观测性。

### Modified Capabilities

无。

## Impact

- 新增 `src/logging/`，并调整服务入口、Express 中间件、飞书同步与 CLI Runner、分析协调器及 Codex Provider 的依赖注入和事件记录。
- `CreateAppOptions`、`Runtime` 和部分构造函数增加可选 Logger 注入点，现有调用方式保持兼容。
- 默认在 `<workspace>/.context/logs/` 写入私有 JSONL 日志；测试环境默认关闭真实输出。
- 不新增对外网络调用，不改变飞书只读边界、LLM Provider 选择、分析输出 Schema 或现有 API 响应格式。
