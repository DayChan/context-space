## MODIFIED Requirements

### Requirement: 安全、隐私与可观测性
系统 SHALL 只向 Provider 发送完成当前分类所需的最小上下文，并记录 Provider、Prompt 版本、Schema 版本、模型信息、开始与结束时间、耗时、用量、状态和脱敏错误。系统 MUST NOT 将凭证写入 Markdown、Prompt、日志或分析结果，也 MUST NOT 默认记录额外的原始工作内容。系统 MUST NOT 将机器人发送的消息或与机器人的 P2P 会话内容发送给 Provider。

#### Scenario: 查看分析来源信息
- **WHEN** 用户打开由 LLM 生成的 Todo 或知识候选
- **THEN** 界面可展示来源引用、置信度、Provider、Prompt 版本和分析时间，但不展示凭证或内部推理

#### Scenario: Provider 产生工具事件
- **WHEN** SDK 事件或 `codex exec --json` 流表明运行尝试执行命令、修改文件、调用 MCP 或进行 Web 搜索
- **THEN** 系统将运行标记为不合规并拒绝持久化其业务结果

#### Scenario: 机器人会话出现在飞书查询结果中
- **WHEN** 飞书返回机器人发送的消息或用户与机器人的 P2P 会话消息
- **THEN** 系统在构造分析请求前排除这些记录，Provider 不接收其内容
