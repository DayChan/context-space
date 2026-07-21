## ADDED Requirements

### Requirement: 显式配置与抓取开关
系统 SHALL 只同步用户显式配置的 Meego 项目空间，并 SHALL 提供独立的 Meego 抓取开关。抓取开关关闭时，系统 MUST NOT 执行任何 `meegle` 业务查询，也 MUST NOT 删除此前已同步的数据。

#### Scenario: 关闭 Meego 抓取
- **WHEN** 用户关闭 Meego 抓取并触发手动同步
- **THEN** 系统跳过所有 `meegle` 业务命令并保留已有 Meego 来源

#### Scenario: 配置多个项目空间
- **WHEN** 用户启用 Meego 抓取并配置多个有效 project key
- **THEN** 系统只在这些项目空间内枚举工作项类型和同步工作项

### Requirement: 只读采集用户参与的工作项
系统 SHALL 使用当前 `meegle` 用户身份和只读命令，对每个已配置空间及其可查询工作项类型执行 MQL 查询。查询 MUST 使用 `all_participate_persons()` 和 `current_login_user()`，不得把仅可访问但用户未参与的工作项持久化。

#### Scenario: 工作项包含当前用户
- **WHEN** 工作项的全部参与人包含当前登录用户
- **THEN** 系统规范化并幂等保存该工作项

#### Scenario: 工作项不包含当前用户
- **WHEN** 工作项可被当前用户访问但全部参与人不包含当前登录用户
- **THEN** 系统不保存该工作项

### Requirement: 跨空间类型发现与完整分页
系统 SHALL 通过项目元数据发现每个已配置空间的可查询工作项类型和公共字段，并 SHALL 完整消费 MQL 分组分页结果。单个空间或类型失败 MUST NOT 阻止其他空间和类型提交成功数据。

#### Scenario: 查询结果超过一页
- **WHEN** 一个工作项类型的参与项超过 MQL 单页上限
- **THEN** 系统使用返回的 session ID 和分组分页信息继续读取，直到所有分组没有下一页

#### Scenario: 停用或特殊类型不可查询
- **WHEN** 元数据返回已停用类型，或类型不支持 `work_item_id`、`name`、`updated_at` 中的普通工作项必需字段
- **THEN** 系统将该类型标记为已跳过而不是同步失败，并继续处理其他类型

#### Scenario: 类型在 Q 标签模式下没有标签字段
- **WHEN** Q 标签时间模式开启且工作项类型不支持 `tags`
- **THEN** 系统将该类型标记为已跳过；关闭 Q 标签时间模式后，该类型仍可按 `updated_at` 同步

### Requirement: Q 标签过滤与时间排序
系统 SHALL 提供 Q 标签时间模式。模式开启时，系统 MUST 在本地仅保留至少一个标签匹配 `Q<季度><月><日>` 的工作项，其中季度为 1 至 4，月日必须构成合法日期且月份属于对应季度。系统 SHALL 使用时间最晚的合法 Q 标签作为排序键和完整分组键，并按标签时间升序排列各组。

#### Scenario: 存在合法 Q 标签
- **WHEN** 工作项包含标签 `Q30828`
- **THEN** 系统将其解析为 Q3 的 08 月 28 日并纳入 Q 标签时间视图

#### Scenario: 不存在合法 Q 标签
- **WHEN** Q 标签时间模式开启且工作项标签均不符合格式或日期校验
- **THEN** 系统不在 Meego 页面展示该工作项

#### Scenario: 存在多个合法 Q 标签
- **WHEN** 工作项同时包含多个合法 Q 标签
- **THEN** 系统保留全部合法标签并使用其中时间最晚者分类和排序

### Requirement: 过滤已完成工作项
系统 SHALL 根据类型元数据选择可用的 `finish_status`、`archiving_status` 或 `finish_time` 字段，将上游完成态规范化为 `completed`。Q 标签和更新时间模式都 MUST 排除 `completed=true` 的工作项。

#### Scenario: 工作项已经完成
- **WHEN** 工作项的布尔完成字段为真，或仅有的完成时间字段存在有效值
- **THEN** 系统保存其完成态但不在 Meego 列表中展示

### Requirement: 更新时间排序模式
Q 标签时间模式关闭时，系统 SHALL 保留所有已同步的用户参与工作项，并按 `updated_at` 从新到旧排序。相同排序时间 MUST 使用稳定工作项 ID 产生确定顺序。

#### Scenario: 关闭 Q 标签时间模式
- **WHEN** 用户关闭 Q 标签时间模式
- **THEN** Meego 页面展示全部已同步参与项并按 `updated_at` 倒序排列

### Requirement: 安全执行与故障状态
系统 MUST 通过独立的 Meegle CLI 只读白名单执行命令，限制并发不超过四并对限流类可重试错误执行有界退避。系统 SHALL 独立报告 Meego 认证、命令、空间、类型、分页和限流错误，不得与 Lark 同步状态混淆。

#### Scenario: Meegle 返回限流
- **WHEN** `meegle` 返回可重试的 QPS 限流错误
- **THEN** 系统按有界退避重试且最多保持四个并发请求

#### Scenario: Meegle 未登录
- **WHEN** Meego 抓取已启用但 `meegle auth status` 未通过
- **THEN** 系统停止 Meego 业务查询并返回可操作的独立认证错误
