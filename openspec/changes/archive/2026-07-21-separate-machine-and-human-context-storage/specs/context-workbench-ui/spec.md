## MODIFIED Requirements

### Requirement: Now 仪表盘
Now 页面 SHALL 组合 Markdown 人工内容与 SQLite 机器数据，展示带优先级原因的重要 Todo、上游任务、近期日历、最近提及、等待事项、待审核候选、知识变更和 Loop 就绪度。

#### Scenario: 渲染当前工作
- **WHEN** Markdown 索引和 SQLite 机器数据包含各类受支持内容
- **THEN** Now 页面渲染每个分类，标明数据所有权并链接到对应详情

### Requirement: 展示来源依据的详情视图
详情视图 SHALL 区分上游机器数据、待审核候选和人工 Markdown，并展示适用的来源引用、最小证据、置信度与审核状态。

#### Scenario: 查看人物视图
- **WHEN** 用户打开同时具备飞书身份、人工备注和待审核洞察的人物
- **THEN** UI 分区展示三类数据，且只有人工备注可直接编辑

### Requirement: 安全的本地编辑
UI SHALL 通过带精确 Origin 和 CSRF Token 的本地 API 使用乐观并发保存人工 Markdown，并 SHALL 在不覆盖较新内容的前提下报告过期写入冲突。

#### Scenario: 提交过期编辑
- **WHEN** 文档在用户加载后发生变化
- **THEN** API 拒绝该过期更新，UI 提示用户重新加载或协调冲突

#### Scenario: 缺少 CSRF Token
- **WHEN** 修改请求来自浏览器但未携带有效 CSRF Header
- **THEN** API 在执行同步、分析、审核、配置或文档写入前拒绝请求

### Requirement: 同步状态可见
Settings 和 Now SHALL 分别展示飞书采集运行与异步分析队列状态，包括来源结果、排队数量、运行任务、可重试失败和终态失败。

#### Scenario: 采集成功但分析失败
- **WHEN** 一次同步采集全部成功但后续 Provider 调用失败
- **THEN** 页面将同步显示为成功，同时独立显示分析失败和重试入口

## ADDED Requirements

### Requirement: 候选审核界面
Inbox SHALL 支持查看、接受和拒绝 Todo、知识及人物洞察候选，并展示接受操作的 `pending`、`materialized`、`accepted` 或 `conflict` 状态。

#### Scenario: 接受知识候选
- **WHEN** 用户审核证据并接受一条知识候选
- **THEN** UI 跟踪可恢复接受状态，成功后导航到确定性知识 Markdown

### Requirement: Markdown 诊断可见
Settings SHALL 展示未知 Schema、非法文档、文件监听和最近校准状态，单个诊断 MUST NOT 阻塞其他有效文档浏览。

#### Scenario: 外部编辑产生非法文档
- **WHEN** 文件监听发现一个无法通过 Schema 校验的 Todo
- **THEN** UI 展示路径和安全错误，同时继续使用其他有效文档
