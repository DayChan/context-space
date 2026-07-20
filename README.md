# Context Space

Context Space 是一个本地优先的工作上下文系统。它通过 `lark-cli` 只读采集与工作有关的飞书消息、日程、任务和人物，将规范记录保存为 Markdown，并在本地 Web 界面中呈现 Todo、人物、知识、时间线和 Loop 就绪状态。

非结构化的群聊提及和 P2P 消息不再通过关键词或正则分类，而是交给 LLM 做语义分析。飞书原生任务、身份归一化、稳定 ID、Schema 校验、优先级和 Markdown 写入仍由确定性代码负责。

## V1 安全边界

- 服务默认只监听 `127.0.0.1`。
- 飞书集成使用 `lark-cli --as user` 和严格的只读命令白名单。
- LLM 在完整拉取落盘后接收有容量上限的批量上下文；每条来源文本都会明确标记为不可信数据。
- Codex 运行在独立空目录、只读沙箱中，并禁用 shell、hooks、apps、多智能体、Web 搜索和 MCP；任何异常工具事件仍会使分析失败。
- 凭证、访问令牌、Prompt 原文和额外来源正文不会写入分析运行 Markdown。
- Provider 失败时仍保存来源并推进同步检查点，不会静默切换 Provider，也不会回退到硬编码分类。
- `workspace/` 默认不进入 Git，因为其中可能包含私人工作内容。
- Loop 可见但不可执行；V1 没有执行端点、调度器或外部动作按钮。

## 环境要求

- Node.js 20 或更新版本
- `lark-cli` 已安装并完成用户身份认证（仅飞书同步需要）
- Codex 已完成认证（LLM 内容分析需要）
- 选择 `codex-exec` 时，`codex` 命令必须位于 `PATH`

Codex SDK 和非交互 CLI 的当前接口说明见 [Codex SDK 官方文档](https://developers.openai.com/codex/sdk/)与 [Codex 非交互模式官方文档](https://developers.openai.com/codex/noninteractive/)。

## 开发

```bash
npm install
npm run dev
```

Web 界面运行于 `http://127.0.0.1:5173`，API 代理到 `http://127.0.0.1:4318`。

## 工作区

规范工作区默认为 `./workspace`，可以通过环境变量使用其他私有目录：

```bash
CONTEXT_SPACE_ROOT=/absolute/private/path npm run dev
```

首次启动时，Context Space 会幂等创建版本化目录和基础 Markdown 配置。搜索与反向链接索引可以随时删除并从 Markdown 重建。

## 飞书同步

Use the Settings page or:

```bash
curl -X POST http://127.0.0.1:4318/api/sync/lark
```

适配器读取群聊提及、P2P 消息、日程、任务和当前用户身份。同步使用检查点和重叠时间窗避免遗漏，并按来源记录失败，不修改飞书数据。

任务查询会显式使用 `--complete=false`，并在标准化阶段再次排除已完成任务。消息和日历窗口使用不含毫秒的秒级 ISO 时间，以兼容飞书字段校验。

如果 `lark-cli` 返回权限不足、认证失效、参数错误或升级通知，Settings 会展示对应来源、错误代码、缺失 scope、官方处理提示以及可用的权限配置或排查链接。系统只提醒，不会自动授权或执行 `lark-cli update`。同步部分失败时，成功来源仍会保留并推进各自检查点。

同步分为两个阶段：先拉取并持久化本轮所有可用来源，再统一映射飞书原生任务，并把提及和 P2P 消息按时间排序后批量送给 LLM。低于批次上限时，本轮消息只产生一次 LLM 请求；超过上限才拆成多个相互隔离的批次。

## LLM 内容分析

工作区首次初始化时会创建 `config/analysis.md`：

```yaml
provider: codex-sdk
model: null
timeout_ms: 120000
max_source_chars: 20000
max_batch_records: 50
max_batch_source_chars: 60000
max_output_bytes: 2000000
prompt_version: context-analysis@2
retain_runs: 50
max_reanalysis_records: 50
```

`max_source_chars` 是单条消息正文上限，`max_batch_records` 和 `max_batch_source_chars` 分别限制单次请求的消息数与正文总字符数。系统会在两个批次上限内尽量装满上下文；不会无边界地把整个历史工作区塞进一次请求。

首期支持两种调用方式：

- `codex-sdk`：默认方式，服务端通过 `@openai/codex-sdk` 创建新线程，并为每次分析传入统一 JSON Schema。SDK 遵循 Codex 的标准本地会话行为，可能在 Codex 主目录下保留会话元数据。
- `codex-exec`：调用本机 `codex exec`，使用 `--ephemeral`、`--sandbox read-only`、`--json`、`--output-schema` 和 `--output-last-message`，不保留会话文件。

可在 Settings 中显式切换 Provider 和模型，也可以调用本地 API：

```bash
curl -X PUT http://127.0.0.1:4318/api/config/analysis \
  -H 'Content-Type: application/json' \
  -d '{"provider":"codex-exec","model":"替换为当前账户可用的模型ID"}'
```

Codex SDK 支持选择模型：非空 `model` 会传给 `startThread({ model })`，Exec 方式会传给 `codex exec --model`。将 `model` 清空或保存为 `null` 时，Codex 使用当前推荐默认模型。系统不硬编码模型列表，也不会在模型不可用时静默切换；可用性由当前 Codex 认证和服务端决定。

部署时可以使用 `CONTEXT_SPACE_ANALYSIS_PROVIDER=codex-sdk` 或 `codex-exec` 覆盖工作区配置。覆盖生效时 Settings 的 Provider 选择会被锁定。认证信息只应保存在 Codex 自身认证存储或进程环境中，不能写入 `config/analysis.md`。

批量输出除 Todo 和知识候选外，还可生成以下人物观察：

- 职责
- 沟通方式
- 协作方式
- 工作偏好

每条生成观察都包含来源引用、逐字证据、置信度、观察时间和稳定键。协作方式类观察至少需要两条不同来源支撑；人工角色、人工备注和 Leader 设置不会被覆盖。系统禁止生成敏感属性、心理诊断、不可变人格类型、绩效或任职适配判断。

### 处理 `tool_activity`

Codex SDK 的运行项目不全是工具调用：`todo_list` 是内部计划，`error` 也可能是无副作用的非致命项目。旧实现只允许 `agent_message` 和 `reasoning`，因此可能把这些项目误报为 `tool_activity`；同时 Provider 在抛错前没有把事件类型带回协调器，所以旧失败记录中的 `event_types` 可能为空。

当前实现允许已知的无副作用项目，并继续拒绝命令执行、文件修改、MCP、Web 搜索及未知项目类型。拒绝时会把真实事件类型写入运行记录。升级后可对原来源重新分析：

```bash
curl -X POST http://127.0.0.1:4318/api/analysis/reanalyze \
  -H 'Content-Type: application/json' \
  -d '{"source_id":"lark:message:替换为失败记录中的来源ID"}'
```

如果新记录中的 `event_types` 是 `todo_list` 或 `error`，当前版本不会再误报；如果出现 `command_execution`、`file_change`、`mcp_tool_call` 或 `web_search`，说明运行确实产生了被禁止的工具活动，结果会继续被拒绝。

### 显式冒烟测试

常规测试不会访问真实 LLM。需要人工验证真实 Provider 时，先启动服务并确认费用与隐私边界，再对一个已经保存的来源执行有界重分析：

```bash
curl -X POST http://127.0.0.1:4318/api/analysis/reanalyze \
  -H 'Content-Type: application/json' \
  -d '{"source_id":"lark:message:替换为真实来源ID"}'
```

分别切换到 `codex-sdk` 和 `codex-exec` 后执行一次，即可验证两条调用链。状态和脱敏错误可通过 `GET /api/analysis/status` 或 Settings 查看。该操作会把选定来源发送给所选模型，且可能产生调用费用；范围重分析会复用相同的批次容量控制。

## 结构化日志

服务默认同时输出终端 JSON 日志，并写入：

```text
workspace/.context/logs/context-space-YYYY-MM-DD.jsonl
```

日期使用 UTC。单个文件默认达到 10 MiB 后轮转为 `context-space-YYYY-MM-DD.1.jsonl`、`.2.jsonl` 等分段，默认保留 14 天。日志目录权限为 `0700`，日志文件权限为 `0600`。日志写入采用后台串行队列；按 `Ctrl+C` 停止 `npm run dev` 时，服务会先关闭监听并刷新待写日志。

每行都是一个可独立解析的 JSON 对象，基础字段为：

- `timestamp`、`level`、`service`、`event`、`pid`
- HTTP 链路使用 `request_id`
- 飞书同步使用 `sync_id`
- LLM 批次使用 `run_id` 和 `batch_id`
- 具体来源事件在适用时使用 `source_id` 或 `source`
- 阶段事件包含安全的数量、状态、耗时、usage、事件类型和错误分类

日志通过环境变量配置：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `CONTEXT_SPACE_LOG_LEVEL` | `info` | `trace`、`debug`、`info`、`warn`、`error`、`fatal` 或 `silent` |
| `CONTEXT_SPACE_LOG_CONSOLE` | `true` | 是否输出到终端 |
| `CONTEXT_SPACE_LOG_FILE` | `true` | 是否写 JSONL 文件 |
| `CONTEXT_SPACE_LOG_DIR` | `<workspace>/.context/logs` | 自定义日志目录；相对路径基于启动目录解析 |
| `CONTEXT_SPACE_LOG_MAX_BYTES` | `10485760` | 单个日志分段的最大字节数，范围 1 KiB 至 1 GiB |
| `CONTEXT_SPACE_LOG_RETENTION_DAYS` | `14` | 文件保留天数，范围 1 至 3650 |

例如只保留 warning 以上的文件日志：

```bash
CONTEXT_SPACE_LOG_LEVEL=warn \
CONTEXT_SPACE_LOG_CONSOLE=false \
npm run dev
```

常用查询：

```bash
# 实时查看当天日志
tail -f workspace/.context/logs/context-space-$(date -u +%F).jsonl | jq .

# 查看错误
jq 'select(.level == "error" or .level == "fatal")' \
  workspace/.context/logs/*.jsonl

# 串联一次同步或 LLM 分析
jq 'select(.sync_id == "替换为同步ID")' workspace/.context/logs/*.jsonl
jq 'select(.run_id == "替换为分析运行ID")' workspace/.context/logs/*.jsonl
```

`.context/sync/*.md` 和 `.context/analysis/runs/*.md` 仍是面向产品状态的规范审计记录；JSONL 日志用于排障和还原执行过程。

日志不会记录 HTTP 查询值或请求体、飞书响应正文、原始消息正文、LLM Prompt、完整模型响应、stdout、stderr、Cookie、认证头或凭证。错误消息、堆栈和 Codex Exec diagnostic 会在持久化前脱敏并截断。不要让多个 Context Space 进程共享同一个日志目录；当前文件轮转按单进程设计。若工作区使用自定义路径，请确保该目录也不会提交到 Git 或公开备份。

## 验证

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

测试使用临时工作区、注入式飞书 Runner 和注入式分析 Provider，不访问真实飞书账号或真实 LLM。
