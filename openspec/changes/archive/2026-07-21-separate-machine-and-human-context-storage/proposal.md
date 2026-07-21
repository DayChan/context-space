## Why

当前系统把飞书来源、分析运行、候选、同步检查点和用户维护内容全部作为 Markdown 保存，同时依赖进程内索引提供查询，导致规范真相、事务边界和恢复语义不一致。随着来源和分析能力增长，这种混合所有权会持续放大部分写入、全量重建、外部编辑不可见和隐私保留成本，因此需要在继续扩展前明确拆分机器数据与人工数据。

## What Changes

- **BREAKING** 将飞书原始来源、上游任务与人物身份、同步运行与游标、分析任务与运行、候选及证据迁移到单个本地 SQLite 数据库，停止为这些机器数据创建新的 Markdown 文档。
- **BREAKING** 所有 LLM 结果必须先成为可审核候选；取消按置信度直接创建 Todo、知识或人物观察的路径。
- 人工维护的 Todo、人物备注和知识文档继续以版本化 Markdown 作为规范真相。
- 增加持久分析队列，飞书同步只负责可靠采集和入队，单个本地 Worker 采用至少一次交付、租约恢复和幂等处理异步分析。
- 飞书增量同步始终覆盖上次成功游标至本次同步的完整区间，并通过近期滚动校准重新读取可能延迟可见的消息；稳定来源 ID 和分析幂等键避免重复处理。
- 增加候选审核与可恢复接受工作流，使用 `pending → materialized → accepted` 状态机幂等创建确定性 Markdown 文档。
- 将 Markdown 索引改为 SQLite 中可重建的投影，采用启动全量校准、文件监听增量更新和定期低频校准。
- Markdown 按版本化 Schema 严格校验；读取兼容旧版本，但不得在启动或普通读取时静默改写用户文档。
- 原始来源正文默认保留 90 天且允许配置；清理后保留来源 ID、时间、参与者、内容摘要哈希和必要审计元数据。
- V1 继续限定为单用户、本机使用，并为修改型 API 增加精确 Origin 校验和 CSRF 防护。
- 提供可重复、可验证的旧工作区迁移，将机器 Markdown 导入 SQLite，并在用户确认前保留原文件备份。

## Capabilities

### New Capabilities

- `machine-context-store`: 定义 SQLite 中机器数据、事务、迁移、保留期和恢复边界。
- `durable-analysis-queue`: 定义持久分析任务的入队、租约、至少一次交付、幂等和重试语义。
- `candidate-review-workflow`: 定义候选审核、接受状态机、确定性 Markdown 物化和冲突恢复。
- `markdown-index-sync`: 定义 Markdown Schema 注册、增量索引、文件监听、校准和非法文档隔离。

### Modified Capabilities

- `markdown-context-store`: 将 Markdown 从全部业务数据的唯一规范数据源收缩为人工维护内容的规范数据源。
- `lark-context-sync`: 将来源与检查点持久化改为 SQLite，并把同步成功与异步分析成功解耦。
- `llm-content-analysis`: 将直接派生文档改为持久队列和 SQLite 候选，并要求所有结果经过人工审核。
- `todo-management`: 区分上游任务与人工 Todo，取消 LLM 高置信度结果直接成为 Todo。
- `people-profiles`: 区分机器身份数据、人工人物备注与待审核人物洞察。
- `knowledge-wiki`: 将生成知识改为 SQLite 候选，接受后才创建 Markdown 知识文档。
- `context-workbench-ui`: 增加采集与分析分离状态、候选审核、接受恢复、Markdown 诊断和本地写请求防护。

## Impact

- 核心持久层新增 SQLite 依赖、Schema migration、事务 Repository、保留期清理和旧工作区迁移。
- `src/adapters/lark` 只负责采集与标准化，不再直接写来源 Markdown或调用分析协调器。
- `src/analysis` 新增持久队列 Worker，并将运行、候选和证据写入 SQLite。
- `src/core` 的 MarkdownStore、Schema 校验和 ContextIndex 将重构为人工文档存储及 SQLite 索引投影。
- API 将新增同步运行、分析任务、候选接受/拒绝和文档诊断端点；修改型端点增加 Origin 与 CSRF 校验。
- Web 工作台需要组合 SQLite 机器数据与 Markdown 人工数据，并展示独立的同步、分析和审核状态。
- 迁移会触及现有工作区目录与测试夹具；旧机器 Markdown 在完成校验和用户确认前不得破坏性删除。
