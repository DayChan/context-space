# Context Space

Context Space 是一个单用户、本机运行的工作上下文系统。它通过 `lark-cli` 只读采集与工作有关的飞书消息、日程、任务和人物，并在本地 Web 界面中呈现 Todo、人物、知识、时间线和 Loop 就绪状态。

存储按所有权拆分：人工维护的 Todo、人物备注和知识以 Markdown 为规范真相；飞书来源、上游数据、同步状态、设置、分析队列、LLM 候选和审核状态以 `.context/context-space.db` 中的 SQLite 为规范真相。LLM 生成的 Todo 和职场洞察会通过幂等流程直接物化为 Markdown；只有知识必须先进入 Inbox，由用户接受后才能物化。

## V1 安全边界

- 服务默认只监听 `127.0.0.1`。
- 所有修改型 API 都要求进程级随机 CSRF Token；带 Origin 的请求还必须通过精确 Origin 校验。
- 飞书集成使用 `lark-cli --as user` 和严格的只读命令白名单。
- LLM 在完整拉取落盘后接收有容量上限的批量上下文；每条来源文本都会明确标记为不可信数据。
- Codex 运行在独立空目录、只读沙箱中，并禁用 shell、hooks、apps、多智能体、Web 搜索和 MCP；任何异常工具事件仍会使分析失败。
- 凭证、访问令牌、Prompt 原文和额外来源正文不会写入 Markdown。
- Provider 失败不影响已经提交的来源和同步游标；分析任务在本地持久队列中有界重试，不会静默切换 Provider。
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

首次启动时，Context Space 会创建人工内容目录、权限为 `0600` 的 SQLite 数据库并执行版本化 migration。Markdown 索引在启动时全量校准，运行时监听单文件变化，并每 5 分钟低频校准一次；索引可以从人工 Markdown 完整重建。

原始来源正文默认保留 90 天，可通过 SQLite 设置 `source_retention_days` 调整。清理后仍保留来源 ID、时间、参与者、正文 SHA-256 和审计元数据；未完成分析或仍被待审核候选引用的正文不会提前清理。

## 飞书同步

使用 Settings 页面触发同步。直接调用修改型 API 时，先读取 CSRF Token：

```bash
CSRF_TOKEN="$(curl -fsS http://127.0.0.1:4318/api/security/csrf | node -pe 'JSON.parse(fs.readFileSync(0)).token')"
curl -X POST http://127.0.0.1:4318/api/sync/lark \
  -H "x-context-space-csrf: ${CSRF_TOKEN}"
```

Settings 也可以启用按分钟或小时执行的定期只读同步。配置保存在 SQLite，服务启动或配置保存后开始重新计时；到点时若已有只读同步运行，本周期会被跳过，不并发执行也不补入队列。配置 API 示例：

```bash
curl -X PUT http://127.0.0.1:4318/api/config/lark-sync-schedule \
  -H 'Content-Type: application/json' \
  -H "x-context-space-csrf: ${CSRF_TOKEN}" \
  -d '{"enabled":true,"interval":30,"unit":"minutes"}'
```

适配器读取群聊提及、P2P 消息、日程、任务和当前用户身份，并按来源记录失败，不修改飞书数据。首次同步默认回填 30 天；后续每次同步都完整覆盖“上次成功检查点至本次同步”的全部区间，不会因为同步间隔较长而只读取最近一小段时间。

飞书消息搜索可能延迟返回已经创建的消息，因此同步还会重复校准最近 1 小时。实际查询起点取“上次成功检查点”和“本次时间减去校准时长”中更早者：长时间未同步时不会截断增量区间，正常定时同步时则回扫近期历史。来源按稳定消息 ID 幂等写入，只有新增或正文变化的消息才重新进入分析队列。可通过 `CONTEXT_SPACE_BACKFILL_DAYS` 和 `CONTEXT_SPACE_RECONCILIATION_HOURS` 调整首次回填与近期校准范围。

消息窗口由应用逐页读取，每页最多 50 条，并在请求下一页前立即持久化；不会使用 `lark-cli --page-all` 把整个窗口聚合到单个 120 秒命令中。消息同步显式关闭未被业务使用的表情富化。若单页失败、下一页游标缺失或重复，或达到每窗口 200 页的安全上限后仍有下一页，系统会保留已经落盘的页面、把来源标记为未完成且不推进检查点；后续同步通过稳定消息 ID 安全回放该时间窗口，不会静默截断或创建重复来源。

任务查询会显式使用 `--complete=false`，并在标准化阶段再次排除已完成任务。消息和日历窗口使用不含毫秒的秒级 ISO 时间，以兼容飞书字段校验。

如果 `lark-cli` 返回权限不足、认证失效、参数错误或升级通知，Settings 会展示对应来源、错误代码、缺失 scope、官方处理提示以及可用的权限配置或排查链接。系统只提醒，不会自动授权或执行 `lark-cli update`。同步部分失败时，成功来源仍会保留并推进各自检查点。

同步只负责把来源、上游任务、身份、游标和分析任务原子提交到 SQLite，采集完成后立即返回，不等待 LLM。本地 Worker Pool 以至少一次交付、确定性幂等键和有期限租约异步消费分析任务；Settings 分别展示同步运行和分析队列状态。

## LLM 内容分析

分析配置保存在 SQLite。旧工作区的 `config/analysis.md` 会在启动时只读、幂等导入，不会被静默改写：

```yaml
provider: codex-sdk
model: null
reasoning_effort: medium
timeout_ms: 120000
max_source_chars: 20000
max_batch_records: 50
max_batch_source_chars: 60000
max_output_bytes: 2000000
prompt_version: context-analysis@4
retain_runs: 50
max_reanalysis_records: 50
```

`max_source_chars` 是单条消息正文上限，`max_batch_records` 和 `max_batch_source_chars` 分别限制单次请求的消息数与正文总字符数。系统会在两个批次上限内尽量装满上下文；不会无边界地把整个历史工作区塞进一次请求。

首期支持两种调用方式：

- `codex-sdk`：默认方式，服务端通过 `@openai/codex-sdk` 创建新线程，并为每次分析传入统一 JSON Schema。SDK 遵循 Codex 的标准本地会话行为，可能在 Codex 主目录下保留会话元数据。
- `codex-exec`：调用本机 `codex exec`，使用 `--ephemeral`、`--sandbox read-only`、`--json`、`--output-schema` 和 `--output-last-message`，不保留会话文件。

可在 Settings 中显式切换 Provider 和模型；选择 `codex-sdk` 时还可以设置推理强度。也可以调用本地 API：

```bash
curl -X PUT http://127.0.0.1:4318/api/config/analysis \
  -H 'Content-Type: application/json' \
  -H "x-context-space-csrf: ${CSRF_TOKEN}" \
  -d '{"provider":"codex-sdk","model":"gpt-5.6-sol","reasoning_effort":"medium"}'
```

Codex SDK 支持选择模型和推理强度：非空 `model` 与 `reasoning_effort` 会分别传给 `startThread({ model, modelReasoningEffort })`。推理强度支持 `minimal`、`low`、`medium`、`high`、`xhigh`，默认 `medium`。Exec 方式仅将模型传给 `codex exec --model`。将 `model` 清空或保存为 `null` 时，Codex 使用当前推荐默认模型。系统不硬编码模型列表，也不会在模型不可用时静默切换；可用性由当前 Codex 认证和服务端决定。

部署时可以使用 `CONTEXT_SPACE_ANALYSIS_PROVIDER=codex-sdk` 或 `codex-exec` 覆盖 SQLite 配置。覆盖生效时 Settings 的 Provider 选择会被锁定。认证信息只应保存在 Codex 自身认证存储或进程环境中。

LLM Worker 数量是独立的调度配置，不进入分析任务快照或幂等键。可在 Settings 中设置为 `1–8`，默认 `1`；扩容立即开始并行领取任务，缩容不会中断正在运行的分析。也可以用 `CONTEXT_SPACE_ANALYSIS_WORKERS=1` 覆盖并锁定该配置，或调用：

```bash
curl -X PUT http://127.0.0.1:4318/api/config/analysis/workers \
  -H 'Content-Type: application/json' \
  -H "x-context-space-csrf: ${CSRF_TOKEN}" \
  -d '{"worker_count":2}'
```

批量输出除 Todo 和知识结果外，还可生成以下人物观察：

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
  -H "x-context-space-csrf: ${CSRF_TOKEN}" \
  -d '{"source_id":"lark:message:替换为失败记录中的来源ID"}'
```

如果新记录中的 `event_types` 是 `todo_list` 或 `error`，当前版本不会再误报；如果出现 `command_execution`、`file_change`、`mcp_tool_call` 或 `web_search`，说明运行确实产生了被禁止的工具活动，结果会继续被拒绝。

### 显式冒烟测试

常规测试不会访问真实 LLM。需要人工验证真实 Provider 时，先启动服务并确认费用与隐私边界，再对一个已经保存的来源执行有界重分析：

```bash
curl -X POST http://127.0.0.1:4318/api/analysis/reanalyze \
  -H 'Content-Type: application/json' \
  -H "x-context-space-csrf: ${CSRF_TOKEN}" \
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

SQLite 中的 `sync_runs`、`analysis_jobs`、`analysis_runs` 和审核表是产品状态的规范审计记录；JSONL 日志用于排障和还原执行过程。

日志不会记录 HTTP 查询值或请求体、飞书响应正文、原始消息正文、LLM Prompt、完整模型响应、stdout、stderr、Cookie、认证头或凭证。错误消息、堆栈和 Codex Exec diagnostic 会在持久化前脱敏并截断。不要让多个 Context Space 进程共享同一个日志目录；当前文件轮转按单进程设计。若工作区使用自定义路径，请确保该目录也不会提交到 Git 或公开备份。

## 旧工作区迁移

启动时会幂等导入旧的来源、同步状态、分析运行、候选和配置 Markdown，并在 `.context/migration-report.json` 生成逐项报告。导入不会删除或改写旧文件。

确认导入数量和候选状态后，可通过本地 API 显式创建可恢复备份：

```bash
curl -X POST http://127.0.0.1:4318/api/migration/backup \
  -H 'Content-Type: application/json' \
  -H "x-context-space-csrf: ${CSRF_TOKEN}" \
  -d '{"confirmed":true}'
```

旧机器 Markdown 会移动到 `.context/legacy-backups/<timestamp>/`，并写入 `backup-report.json`。人工 Todo、人物备注和知识不会移动。

迁移兼容边界：

- 人工 Markdown 当前支持仓库既有的 `todo@1`、`person@1` 和 `knowledge@1`；未知 Schema 只进入诊断，不会被改写。
- 旧的未结束分析运行无法安全续跑，导入时会转为终态失败，等待用户显式重试。
- 旧候选的证据只有在对应来源已成功导入时才写入证据表；稳定 `source_refs` 仍会保留。
- 已经存在于人物 Markdown 中的旧人物观察继续视为人工可维护内容，不会反向拆回候选。
- 迁移报告存在失败或冲突时，备份 API 会拒绝移动旧文件。

## 验证

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

测试使用临时工作区、注入式飞书 Runner 和注入式分析 Provider，不访问真实飞书账号或真实 LLM。
