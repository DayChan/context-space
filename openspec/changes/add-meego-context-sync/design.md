## Context

当前应用通过 `lark-cli` 采集消息、日历和任务，并把规范来源写入 SQLite。Lark runner、来源类型、同步状态和 Settings 都围绕单一 CLI 构建。Meego 使用独立的 `meegle` CLI、独立认证和动态项目元数据；项目发现只能覆盖最近访问空间，因此同步范围必须由用户显式配置。Meegle MQL 可以筛选全部参与人包含当前用户的工作项，但不支持对多选标签执行正则或 `LIKE`，Q 标签必须在本地解析。

## Goals / Non-Goals

**Goals:**

- 只读、可审计地同步显式项目空间内当前用户参与的工作项。
- 在不污染现有 Lark 同步边界的前提下复用机器来源存储。
- 用两个 Settings 开关独立控制是否抓取 Meego、是否按 Q 标签过滤和排序。
- 对动态类型、分页、限流和局部失败提供确定行为和测试覆盖。

**Non-Goals:**

- 不创建、修改、评论或流转 Meego 工作项。
- 不承诺自动发现全部可访问项目空间。
- 不把 Meego 工作项送入现有消息 LLM 分析队列。
- 不根据当前负责人、创建者或待办状态替代“全部参与人”语义。

## Decisions

### 独立 Meegle 同步边界

新增 `MeegleCliCommandRunner`、`MeegoAdapter` 和 `MeegoSyncService`，使用独立 API 与状态。runner 使用 `execFile` 且只允许 `auth status`、`workitem meta-types`、`workitem meta-fields` 和 `workitem query`。不扩展现有 Lark 白名单，因为两个 CLI 的身份、错误格式和限流策略不同。

### 复用来源表并扩展领域类型

来源 provider 扩展为 `lark | meegle`，kind 增加 `meego`，稳定 ID 使用 `meegle:<project-key>:<type-key>:<work-item-id>`。工作项名称作为正文，项目、类型、标签、Q 标签、排序时间、更新时间和上游 URL 保存在 metadata。SQLite 列本身是 TEXT，无需结构迁移；TypeScript、查询投影和保留策略需要识别新类型。

### 配置使用枚举语义、UI 使用开关

持久配置保存 `enabled`、`projectKeys` 和 `qTagTimelineEnabled`。两个布尔值与产品开关一一对应；排序模式由 `qTagTimelineEnabled` 唯一推导，避免同时保存互相矛盾的过滤与排序字段。项目 key 规范化、去空、去重后保存。

### 服务端筛参与、本地筛 Q 标签

每个项目先枚举类型和字段，仅对具备最小公共字段的类型构造 MQL。WHERE 固定为 `array_contains(all_participate_persons(), current_login_user())`。MQL 只负责参与人过滤和 `updated_at` 排序；规范化后解析 Q 标签并校验真实日期及季度一致性。完成态按类型依次选择 `finish_status`、`archiving_status` 或 `finish_time` 并统一存为 `completed`；读取 API 在两种模式下都排除已完成项。开关只影响读取 API 的标签过滤排序，不删除因切换模式而暂时不可见的已同步来源。

### 完整快照与有界并发

初版对每个已配置项目和类型执行完整分页快照，使用最多四个 worker，避免超过实测 5 QPS。限流错误最多重试两次并指数退避。成功完成的项目类型以稳定 ID upsert；局部失败不清理该范围的旧数据。完整清理陈旧数据需要可证明的全量范围，本次仅保留最新 upsert，避免因不完整分页误删。

### Q 标签排序没有年份

Q 标签只提供季度、月、日，因此排序键使用 `quarter/month/day`，不合成年份。页面按完整主标签（例如 `Q30717`）分组，分组按季度/月/日升序；多个合法标签选择月日最晚者作为主分组标签并展示全部匹配标签。更新时间模式使用 `updated_at` 倒序，最终用稳定 ID 打破平局。

## Risks / Trade-offs

- [完整快照在项目和类型较多时请求量较大] → 限制四并发、完整分页并展示进度，后续基于真实规模再引入增量游标。
- [项目类型字段高度动态] → 同步前读取元数据，只选择存在的最小字段；类型失败按范围隔离。
- [关闭抓取后旧数据仍可见] → 页面明确显示数据来自上次成功同步；抓取开关控制外部读取，不隐式删除历史。
- [Q 标签没有年份] → 只按季度和月日排序，不伪造绝对年份。
- [CLI 输出结构随服务端变化] → 规范化器兼容 envelope 和分组列表形态，未知形态失败而不是静默报告空结果。

## Migration Plan

1. 扩展类型和配置默认值，默认关闭 Meego 抓取与 Q 标签模式，保持现有行为不变。
2. 增加独立 runner、同步服务和 API，再接入 Settings 与导航。
3. 用户安装并登录 `meegle`、配置项目 key 后显式开启同步。
4. 回滚时关闭 Meego 抓取并移除 UI/API 装配；已有来源记录可保留且不会影响 Lark 数据。

## Open Questions

无。标签年份缺失按季度内排序处理，项目空间由用户手动配置。
