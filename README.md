# Context Space

Context Space 是一个本地优先的工作上下文系统。它通过 `lark-cli` 只读采集与工作有关的飞书消息、日程、任务和人物，将规范记录保存为 Markdown，并在本地 Web 界面中呈现 Todo、人物、知识、时间线和 Loop 就绪状态。

非结构化的群聊提及和 P2P 消息不再通过关键词或正则分类，而是交给 LLM 做语义分析。飞书原生任务、身份归一化、稳定 ID、Schema 校验、优先级和 Markdown 写入仍由确定性代码负责。

## V1 安全边界

- 服务默认只监听 `127.0.0.1`。
- 飞书集成使用 `lark-cli --as user` 和严格的只读命令白名单。
- LLM 只接收当前来源的最小必要上下文；来源文本会明确标记为不可信数据。
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

## LLM 内容分析

工作区首次初始化时会创建 `config/analysis.md`：

```yaml
provider: codex-sdk
model: null
timeout_ms: 120000
max_source_chars: 20000
max_output_bytes: 2000000
prompt_version: context-analysis@1
retain_runs: 50
max_reanalysis_records: 50
```

首期支持两种调用方式：

- `codex-sdk`：默认方式，服务端通过 `@openai/codex-sdk` 创建新线程，并为每次分析传入统一 JSON Schema。SDK 遵循 Codex 的标准本地会话行为，可能在 Codex 主目录下保留会话元数据。
- `codex-exec`：调用本机 `codex exec`，使用 `--ephemeral`、`--sandbox read-only`、`--json`、`--output-schema` 和 `--output-last-message`，不保留会话文件。

可在 Settings 中显式切换，也可以调用本地 API：

```bash
curl -X PUT http://127.0.0.1:4318/api/config/analysis \
  -H 'Content-Type: application/json' \
  -d '{"provider":"codex-exec"}'
```

部署时可以使用 `CONTEXT_SPACE_ANALYSIS_PROVIDER=codex-sdk` 或 `codex-exec` 覆盖工作区配置。覆盖生效时 Settings 的 Provider 选择会被锁定。认证信息只应保存在 Codex 自身认证存储或进程环境中，不能写入 `config/analysis.md`。

### 显式冒烟测试

常规测试不会访问真实 LLM。需要人工验证真实 Provider 时，先启动服务并确认费用与隐私边界，再对一个已经保存的来源执行有界重分析：

```bash
curl -X POST http://127.0.0.1:4318/api/analysis/reanalyze \
  -H 'Content-Type: application/json' \
  -d '{"source_id":"lark:message:替换为真实来源ID"}'
```

分别切换到 `codex-sdk` 和 `codex-exec` 后执行一次，即可验证两条调用链。状态和脱敏错误可通过 `GET /api/analysis/status` 或 Settings 查看。该操作会把当前来源的最小内容发送给所选模型，且可能产生调用费用。

## 验证

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

测试使用临时工作区、注入式飞书 Runner 和注入式分析 Provider，不访问真实飞书账号或真实 LLM。
