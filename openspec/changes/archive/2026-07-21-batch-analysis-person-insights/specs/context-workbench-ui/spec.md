## ADDED Requirements

### Requirement: 配置分析模型与批次
Settings SHALL 展示当前分析 Provider、可选模型和批次容量配置。用户 SHALL 能保存非空模型标识或清空为 Codex 默认模型；界面 MUST 说明模型可用性由当前认证决定，配置只影响后续分析运行。

#### Scenario: 保存 SDK 模型
- **WHEN** 用户在 Settings 输入模型标识并保存
- **THEN** 系统原子更新分析配置，界面显示该模型将用于后续 `codex-sdk` 或 `codex-exec` 运行

#### Scenario: 清空模型
- **WHEN** 用户清空模型输入并保存
- **THEN** 系统把模型配置保存为 `null`，后续运行使用 Codex 当前默认模型

## MODIFIED Requirements

### Requirement: 展示来源依据的详情视图
详情视图 SHALL 展示管理模式、来源引用、适用时的置信度，并区分生成内容与用户拥有的内容。人物详情 SHALL 按类别展示推断的职责和职场协作观察，包括证据、来源、置信度和观察时间。

#### Scenario: 查看混合管理人物档案
- **WHEN** 用户打开包含人工内容和生成观察的人物档案
- **THEN** UI 在视觉上区分可编辑的用户内容与有证据支撑的生成观察，并展示每条观察的类别、来源和置信度

#### Scenario: 查看混合管理 Todo
- **WHEN** 用户打开由批量分析生成且后来被人工编辑的 Todo
- **THEN** UI 保留并展示用户拥有的字段，同时展示其分析来源、Provider、Prompt 版本和证据
