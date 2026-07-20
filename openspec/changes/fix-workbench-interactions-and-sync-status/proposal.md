## Why

当前工作台缺少 Todo 状态交互、人物来源消息的可读展示和同步过程可观测性，同时机器人 P2P 会话仍可能进入统计与 LLM 分析。这会导致用户无法可靠维护行动项、无法核验证据，也无法判断同步是否卡住或泄露了不应分析的机器人上下文。

## What Changes

- 为 Todo 提供可点击的完成/重新打开操作，并保证本地状态不会被后续只读同步覆盖。
- 在飞书查询和本地规范化两层排除机器人发送的消息及与机器人的整个 P2P 会话，使其不进入存储、人物统计和 LLM 输入。
- 将 People 的 Provenance 来源引用解析为可阅读、可跳转的具体消息。
- 新增实时同步状态 API 与状态窗口，展示当前阶段、来源、时间窗口、分页、采集数量和错误。
- 为上述行为补充 API、同步服务和 Web UI 回归测试。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `todo-management`: Todo 支持用户更新完成状态，并保留用户维护的生命周期状态。
- `lark-context-sync`: 排除机器人会话，并暴露运行中的细粒度同步进度与错误。
- `context-workbench-ui`: 提供 Todo 状态操作、可读的人物来源消息和实时同步状态窗口。
- `llm-content-analysis`: 明确禁止将机器人会话内容发送给分析 Provider。

## Impact

影响 Todo 写入与 API、飞书适配器和同步服务、People 详情 API、React 工作台与样式，以及相关测试和 OpenSpec 文档。不新增外部依赖，不改变飞书只读边界。
