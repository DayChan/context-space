## Why

当前系统依赖关键词和正则表达式判断消息中的行动项与决策，难以理解上下文、隐含意图和多语言表达，也会随着分类规则增加而变得难以维护。需要改为由版本化 Prompt 驱动的 LLM 语义分析，并通过统一调用契约隔离具体接入方式。

## What Changes

- 移除对非结构化输入进行语义分类的硬编码关键词与正则规则，改用 LLM 分析消息中的 Todo 和知识候选。
- 建立统一的分析 Provider 接口、注册表和配置模型，使业务流程不依赖具体 SDK、CLI 或未来其他模型接入方式。
- 首期实现 `codex-sdk` 与 `codex-exec` 两个 Provider，并允许在 Settings 或配置文件中显式切换；切换对下一次分析生效。
- 建立版本化 Prompt 模板和统一 JSON Schema，两个 Provider 使用相同输入、输出、置信度、证据与来源契约。
- 使用结构化输出和运行时校验拒绝不完整或越界结果；Provider 失败时保留来源文档并记录可重试状态，不再回退到硬编码分类。
- 将 LLM 调用限制在隔离、只读、无外部动作的运行环境中，防止来源内容中的提示注入触发工具、文件修改或外部操作。
- 为 Provider、Prompt 版本、模型信息、耗时、用量、错误和分析状态增加可追溯元数据，同时避免记录凭证和不必要的原始敏感内容。
- 增加 Provider 契约测试、Prompt 评测样例、提示注入测试、切换测试和失败恢复测试，自动化测试不访问真实 LLM。

## 能力

### 新增能力

- `llm-content-analysis`：基于版本化 Prompt 的内容分析、统一结构化输出、可扩展 Provider 契约、Codex SDK 与 `codex exec` 双实现、运行时切换、安全边界、失败处理和可观测性。

### 修改能力

无。现有 Todo、知识和工作台能力的业务契约保持不变，本变更替换其非结构化内容分析机制并补充新的分析能力契约。

## 影响

- `src/core/analyzer.ts` 的同步正则分析将被新的异步 LLM 分析服务替代。
- 新增分析领域契约、Prompt 模板、输出 Schema、Provider 注册表、Codex SDK Provider 和 `codex exec` Provider。
- `src/adapters/lark/sync.ts` 需要支持异步分析状态、幂等重试以及分析失败与来源同步解耦。
- 本地 API、Settings 页面和工作区配置需要展示并切换分析 Provider，同时提供可用性与最近运行状态。
- npm 依赖将新增 `@openai/codex-sdk`；`codex-exec` 方式要求本机存在可用的 `codex` CLI。
- 非结构化工作内容会发送给用户选择的 Codex 调用方式，因此需要明确隐私提示、最小上下文策略和凭证隔离。
