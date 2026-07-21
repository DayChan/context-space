## ADDED Requirements

### Requirement: Meego 配置界面
Settings SHALL 提供 Meego 抓取开关、Q 标签过滤与排序开关，以及手动维护 project key 列表的配置界面。保存成功后，界面 MUST 显示服务端持久化后的真实配置；保存失败时 MUST 保留用户输入并展示错误。

#### Scenario: 启用 Meego 抓取
- **WHEN** 用户在 Settings 开启 Meego 抓取、填写至少一个 project key 并保存
- **THEN** 后续手动 Meego 同步使用持久化后的项目列表

#### Scenario: 切换 Q 标签模式
- **WHEN** 用户修改 Q 标签过滤与排序开关并保存
- **THEN** Meego 页面按新模式重新过滤和排序已有同步数据

### Requirement: Meego 分类页面
主导航 SHALL 提供独立的 Meego 分类页面。页面 SHALL 展示工作项标题、项目、工作项类型、更新时间、匹配的 Q 标签和上游链接，并根据当前配置显示 Q 标签时间分组或更新时间列表。

#### Scenario: 使用 Q 标签时间模式展示
- **WHEN** Q 标签模式开启且存在带合法 Q 标签的参与工作项
- **THEN** 页面以完整标签（例如 `Q30717`）作为组标题，并按解析标签时间升序展示各组

#### Scenario: 使用更新时间模式展示
- **WHEN** Q 标签模式关闭且存在已同步参与工作项
- **THEN** 页面不按标签过滤并按更新时间倒序展示全部工作项

#### Scenario: 隐藏已完成工作项
- **WHEN** 已同步工作项的规范完成态为已完成
- **THEN** Meego 页面在 Q 标签和更新时间两种模式下都不展示该工作项

### Requirement: Meego 同步状态可见
Settings 和 Meego 页面 SHALL 提供独立的 Meego 手动同步入口和状态，至少展示是否运行、完成时间、项目或类型级错误、接收数量和持久化数量。关闭 Meego 抓取时，入口 SHALL 明确显示已停用且不得启动业务查询。

#### Scenario: 部分项目同步失败
- **WHEN** 一轮 Meego 同步中部分项目或类型失败而其他查询成功
- **THEN** 页面保留成功数据并同时展示失败范围与错误

#### Scenario: 工作项类型被正常跳过
- **WHEN** 工作项类型已停用、不是普通工作项，或不支持当前过滤模式要求的字段
- **THEN** 页面不把该范围渲染为错误或提示卡片，仅在服务端同步状态中保留跳过结果
