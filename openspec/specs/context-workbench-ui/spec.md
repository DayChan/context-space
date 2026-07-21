# 上下文工作台界面规范

## Purpose

本规范用于定义单用户本地上下文工作台如何组合 SQLite 机器数据与人工 Markdown，提供稳定导航、候选审核、来源依据、安全编辑以及彼此独立的同步和分析状态。

## Requirements

### Requirement: 稳定的主导航
Web UI SHALL 提供 Now、Inbox、Todos、People、Knowledge、Timeline、Loop 和 Settings 的主要路由。

#### Scenario: 在工作台中导航
- **WHEN** 用户依次选择各个主导航项
- **THEN** 对应页面在本地加载，且无需整页刷新

### Requirement: Now 仪表盘
Now 页面 SHALL 组合 Markdown 人工内容与 SQLite 机器数据，展示带优先级原因的重要 Todo、上游任务、近期日历、最近提及、等待事项、待审核候选、知识变更和 Loop 就绪度。

#### Scenario: 渲染当前工作
- **WHEN** Markdown 索引和 SQLite 机器数据包含各类受支持内容
- **THEN** Now 页面渲染每个分类，标明数据所有权并链接到对应详情

### Requirement: 浏览与筛选
UI SHALL 允许用户浏览和筛选 Todo、人物、知识、Inbox 和时间线数据，并执行全文搜索。

#### Scenario: 按承诺方向筛选 Todo
- **WHEN** 用户选择“等待他人”的筛选条件
- **THEN** 只显示方向为 `waiting_on_them` 的 Todo

### Requirement: 展示来源依据的详情视图
详情视图 SHALL 分区展示上游机器数据、待审核候选和人工 Markdown，并展示适用的来源引用、最小证据、置信度、Provider、Prompt 版本与审核状态。原始正文仍在保留期内时可展示消息标题、时间和正文；正文已清理时 SHALL 保留可解析的来源身份与必要审计元数据。

#### Scenario: 查看组合管理详情
- **WHEN** 用户打开同时包含机器数据、候选和人工内容的人物或 Todo 详情
- **THEN** UI 在视觉上分区展示三类数据，且只有人工 Markdown 可直接编辑

#### Scenario: 查看组合人物档案
- **WHEN** 用户打开包含人工备注和人物洞察候选的人物视图
- **THEN** UI 分区展示可编辑的人工备注与有证据支撑的候选，并展示每条候选的类别、来源和置信度

#### Scenario: 查看候选接受产生的 Todo
- **WHEN** 用户打开由候选接受产生并由用户继续编辑的 Todo Markdown
- **THEN** UI 展示用户拥有的字段、候选 ID、分析来源、Provider、Prompt 版本和用户确认的最小证据

#### Scenario: 查看人物来源消息
- **WHEN** 用户打开含有消息来源引用的人物详情
- **THEN** UI 在正文仍被保留时展示消息时间与内容，否则展示来源身份、时间、参与者和摘要哈希

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
Settings 和 Now SHALL 展示飞书可用性、手动只读同步入口，并分别展示飞书采集运行与异步分析队列状态。采集状态 SHALL 包括当前阶段、来源、窗口、分页、数量和错误；分析状态 SHALL 包括排队数量、运行任务、可重试失败和终态失败。

#### Scenario: 展示局部同步失败
- **WHEN** 一次同步完成但其中一个来源失败
- **THEN** 页面同时展示成功数量和失败来源的消息

#### Scenario: 观察运行中的同步
- **WHEN** 用户触发手动同步
- **THEN** 状态窗口持续更新当前采集或分析步骤，并在发生错误时展示可操作的错误消息

#### Scenario: 采集成功但分析失败
- **WHEN** 一次同步采集全部成功但后续 Provider 调用失败
- **THEN** 页面将同步显示为成功，同时独立显示分析失败和重试入口

### Requirement: 配置分析模型与批次
Settings SHALL 展示当前分析 Provider、可选模型和批次容量配置。用户 SHALL 能保存非空模型标识或清空为 Codex 默认模型；界面 MUST 说明模型可用性由当前认证决定，配置只影响后续分析运行。

#### Scenario: 保存 SDK 模型
- **WHEN** 用户在 Settings 输入模型标识并保存
- **THEN** 系统原子更新分析配置，界面显示该模型将用于后续 `codex-sdk` 或 `codex-exec` 运行

#### Scenario: 清空模型
- **WHEN** 用户清空模型输入并保存
- **THEN** 系统把模型配置保存为 `null`，后续运行使用 Codex 当前默认模型

### Requirement: Todo 状态交互
工作台 SHALL 在人工 Todo 的列表、Now 概览和详情中提供可访问的状态控件，用于标记完成或重新打开，并在失败时恢复原状态和展示错误；SQLite 上游任务状态保持只读。

#### Scenario: 从列表完成 Todo
- **WHEN** 用户点击开放 Todo 的完成控件且 API 保存成功
- **THEN** 控件变为已完成状态，详情与后续加载读取同一持久化结果

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
