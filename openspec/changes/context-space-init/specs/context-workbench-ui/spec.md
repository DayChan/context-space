## ADDED Requirements

### Requirement: 稳定的主导航
Web UI SHALL 提供 Now、Inbox、Todos、People、Knowledge、Timeline、Loop 和 Settings 的主要路由。

#### Scenario: 在工作台中导航
- **WHEN** 用户依次选择各个主导航项
- **THEN** 对应页面在本地加载，且无需整页刷新

### Requirement: Now 仪表盘
Now 页面 SHALL 展示带优先级原因的重要 Todo、近期日历事项、最近提及、等待事项、待审核候选、知识变更和 Loop 就绪度。

#### Scenario: 渲染当前工作
- **WHEN** 已建立索引的工作区数据包含各类受支持的概览信息
- **THEN** Now 页面渲染每个分类，并将条目链接到对应详情视图

### Requirement: 浏览与筛选
UI SHALL 允许用户浏览和筛选 Todo、人物、知识、Inbox 和时间线数据，并执行全文搜索。

#### Scenario: 按承诺方向筛选 Todo
- **WHEN** 用户选择“等待他人”的筛选条件
- **THEN** 只显示方向为 `waiting_on_them` 的 Todo

### Requirement: 展示来源依据的详情视图
详情视图 SHALL 展示管理模式、来源引用、适用时的置信度，并区分生成内容与用户拥有的内容。

#### Scenario: 查看混合管理文档
- **WHEN** 用户打开混合管理的人物档案或 Todo
- **THEN** UI 在视觉上区分可编辑的用户内容与有证据支撑的生成内容

### Requirement: 安全的本地编辑
UI SHALL 通过本地 API 使用乐观并发保存受支持的编辑，并 SHALL 在不覆盖较新内容的前提下报告过期写入冲突。

#### Scenario: 提交过期编辑
- **WHEN** 文档在用户加载后发生了变化
- **THEN** API 拒绝该过期更新，UI 提示用户重新加载或协调冲突

### Requirement: 同步状态可见
Settings 和 Now SHALL 展示飞书可用性、上次运行状态、各来源结果以及手动只读同步触发入口。

#### Scenario: 展示局部同步失败
- **WHEN** 一次同步完成但其中一个来源失败
- **THEN** 页面同时展示成功数量和失败来源的消息
