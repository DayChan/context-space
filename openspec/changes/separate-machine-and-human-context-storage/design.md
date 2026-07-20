## Context

Context Space 当前把用户维护内容、飞书原始来源、同步检查点、分析运行和 LLM 候选统一存储为 Markdown，并在进程启动或写操作后全量重建内存索引。单文件原子替换可以防止文件撕裂，但无法为一次同步或分析提供跨文件事务；进程内索引也无法可靠感知外部编辑，失败的全量重建可能留下部分索引。

本变更面向单用户、本机运行的 V1，不引入远程服务。系统需要继续支持用户直接使用编辑器维护 Todo、人物备注和知识，同时为机器采集、异步分析、审核状态和数据保留提供可靠事务。

## Goals / Non-Goals

**Goals:**

- 用数据所有权决定规范存储：人工内容使用 Markdown，机器状态使用 SQLite。
- 使同步、异步分析、候选审核和接受操作具有明确、可恢复的状态语义。
- 让 Markdown 外部编辑近实时进入查询索引，同时允许索引完全重建。
- 通过版本化 Schema 保护用户文档，兼容旧版本但禁止静默迁移。
- 提供旧工作区的非破坏性、幂等迁移路径。
- 限制原始工作内容的长期保留，并保护本地修改型 API。

**Non-Goals:**

- 不支持多用户、局域网或远程访问。
- 不引入 Redis、外部数据库、分布式锁或多 Worker。
- 不实现 Markdown 与 SQLite 之间的虚假原子事务。
- 不在本变更中启用 Loop 自动执行。
- 不自动改写未知或旧版本的用户 Markdown。

## Decisions

### 1. 按所有权拆分规范存储

人工维护的 Todo、人物备注和知识文档是 Markdown 规范数据。飞书来源、上游任务与身份、运行状态、配置、分析任务、分析运行、候选及审核操作是 SQLite 规范数据。Markdown 中的来源引用只保存稳定 ID，不要求原始正文永久存在。

该方案优于“全部 Markdown”，因为机器工作流需要事务、唯一约束、租约和按期限清理；也优于“全部 SQLite”，因为用户需要直接编辑、备份和迁移长期知识。

### 2. 使用单个嵌入式 SQLite 数据库

数据库位于 `<workspace>/.context/context-space.db`，使用 `better-sqlite3`、WAL、外键、`busy_timeout` 和显式 migration 表。数据库访问封装在薄 Repository 层，业务层不得拼接未参数化 SQL。

SQLite 事务负责：

- 来源与分析任务同时提交；
- 分析运行与候选同时提交；
- 队列领取、续租、完成和重试；
- 接受工作流状态推进；
- 保留期清理。

不采用 ORM，避免为有限且稳定的本地 Schema 引入额外模型层和迁移抽象。

### 3. SQLite 数据模型按职责划分

核心表包括：

- `sources`、`source_participants`、`upstream_tasks`、`upstream_people`
- `sync_runs`、`sync_source_runs`、`sync_cursors`
- `analysis_jobs`、`analysis_runs`
- `analysis_candidates`、`candidate_evidence`
- `acceptance_operations`
- `markdown_documents`、`markdown_backlinks`
- `settings`、`schema_migrations`

`sources(provider, external_id)`、`analysis_jobs(idempotency_key)`、`analysis_candidates(run_id, stable_key)` 和 `acceptance_operations(candidate_id)` 具有唯一约束。

### 4. 同步与分析解耦

飞书同步分页采集并在每个完成窗口的事务中 upsert 来源、推进游标和创建分析任务。HTTP 同步请求在采集完成后返回，不等待 Provider。

分析由单个本地 Worker 处理。任务采用 `queued`、`leased`、`succeeded`、`failed_retryable`、`failed_terminal` 状态；租约超时后可重新领取。交付语义为至少一次，幂等键由来源集合摘要、Prompt 版本、输出 Schema 版本、Provider、模型和有效配置摘要构造。

### 5. 所有 LLM 输出先成为候选

有效分析输出只写入 SQLite 候选和证据，不直接创建 Todo、人物观察或知识 Markdown。置信度用于排序和提示，不能绕过用户审核。拒绝候选保留最小审计元数据，并遵循正文保留期。

飞书原生任务和目录人物同样是上游机器数据；UI 可以展示它们，但只有用户显式接受或创建人工记录时才产生 Markdown。

### 6. 接受操作使用可恢复状态机

接受候选时：

1. SQLite 事务创建或读取唯一的 `acceptance_operation`，状态为 `pending`。
2. 使用候选 ID 派生稳定文档 ID 和路径，以原子替换或 `createOnly` 方式物化 Markdown。
3. SQLite 将操作推进为 `materialized`，记录文档 ID、路径和 ETag。
4. SQLite 将候选及操作推进为 `accepted`。

启动恢复任务重新处理 `pending` 和 `materialized`：

- 文件不存在时重新创建；
- 文件存在且 `candidate_id`、文档 ID 匹配时补记接受；
- 文件存在但身份不匹配时进入 `conflict`，禁止覆盖。

不尝试在数据库失败后删除已创建 Markdown，因为删除回滚比幂等前滚更危险。

### 7. Markdown 使用版本化 Schema Registry

读取器依据 `frontmatter.schema` 选择严格运行时 Schema，并转换为当前领域模型。旧版本解析器继续可读但不改写磁盘；未知新版本只读诊断；非法文档进入诊断列表，保留上一次有效索引且不阻塞其他文件。

通用 `Record<string, unknown>` 更新接口将被类型化命令替代。新文档只写最新 Schema。

### 8. Markdown 索引是 SQLite 可重建投影

启动时执行全量校准；运行期间使用文件监听做单文件增量更新；定期按路径、修改时间、大小和内容摘要做低频校准，补偿丢失事件。API 写入也走同一个单文件索引入口，不触发全量重建。

索引重建先写入临时 generation，再原子切换当前 generation，防止坏文件或中断暴露半成品索引。

### 9. 原始正文默认保留 90 天

`settings` 保存可配置保留天数。清理任务只处理已经完成分析且不再被待审核候选阻塞的来源；到期后将正文置空并记录清理时间，保留来源 ID、时间、参与者、正文摘要哈希和必要审计元数据。

接受后的 Markdown 默认保留用户在审核时确认的最小证据摘录，而不是整条原始消息。该行为可在实现前通过规格确认，但数据库清理不得依赖完整 Markdown 副本。

### 10. 本地 API 仍需要写请求防护

服务只监听 loopback。前端通过同源只读端点获取进程级随机 CSRF Token，修改请求必须携带自定义 Header；服务同时校验精确 Origin。无 Origin 的本地脚本请求仍必须携带 Token。该设计不扩展为账号或远程认证系统。

### 11. 查询层组合机器数据与人工数据

Todo、人物、知识和概览 API 使用 Query Service 组合 SQLite 上游数据、候选状态和 Markdown 索引投影。领域写入通过明确的 use case 执行，不允许 Controller 直接协调多个 Store。

`server/app.ts` 只负责 HTTP 解析、验证和错误映射；同步、审核、文档写入和查询分别进入独立服务。

## Risks / Trade-offs

- [SQLite 与 Markdown 无法共享事务] → 使用确定性 ID、持久接受状态机和启动前滚恢复，不做删除回滚。
- [引入原生 SQLite 依赖可能增加安装成本] → 固定受支持 Node 版本，在 CI 验证安装与打包，并保持数据库访问层可替换。
- [迁移期间出现双读或双写分歧] → 迁移分阶段切换所有权，每类数据只允许一个新写入路径；旧文件只读备份。
- [文件监听可能丢事件或产生重复事件] → 事件处理幂等，并用启动及定期摘要校准兜底。
- [单 Worker 吞吐有限] → V1 优先确定性和费用控制；记录排队时间，只有量化瓶颈后才增加受限并发。
- [90 天清理降低历史重分析能力] → 在清理前阻止删除未完成分析或待审核候选依赖的正文，并在 UI 明示保留策略。
- [一次变更影响多个能力] → 按存储、同步、队列、审核、索引、迁移六个阶段交付，每阶段保留测试和兼容入口。

## Migration Plan

1. 引入 SQLite、migration runner、事务 Repository 和备份诊断，不改变产品读写。
2. 将来源、同步状态、上游任务和人物身份切换到 SQLite；停止创建新的机器来源 Markdown。
3. 引入持久分析队列和单 Worker，将分析运行及结果切换到 SQLite。
4. 增加候选审核和接受状态机；停止创建新的候选 Markdown。
5. 引入 Markdown Schema Registry、SQLite 索引、文件监听和校准，移除请求路径的全量内存重建。
6. 幂等导入旧来源、运行、候选和配置 Markdown，生成逐项迁移报告。
7. 验证数量、稳定 ID、引用和状态后，将旧机器 Markdown 移入带时间戳的工作区备份目录；仅在用户显式确认后提供删除。

每个阶段失败时回滚应用版本并保留 SQLite 和旧 Markdown。数据库 migration 必须只前进；破坏性 Schema 变化通过新表复制和原表备份完成。

## Resolved Choices

- 接受后的 Markdown 在 V1 始终保留用户审核过的最小证据摘录。
- 旧工作区配置幂等导入 SQLite；旧文件只作为迁移输入和确认前备份，不构成运行时覆盖层。
- 原生飞书任务在 V1 作为独立、只读的上游任务展示，不提供自动转为人工 Todo。
