## Why

Context Space 当前只能采集飞书消息、日历和任务，无法把用户参与的飞书项目（Meego）工作项纳入统一工作上下文。用户需要在明确配置的项目空间内只读同步自己参与的工作项，并能选择按更新时间展示全部工作项，或仅展示带有可解析 Q 时间标签的工作项。

## What Changes

- 新增基于官方 `meegle` CLI 的只读 Meego 同步，项目空间由用户显式配置。
- 仅采集 `all_participate_persons()` 包含当前登录用户的工作项，跨项目空间和工作项类型分页读取并幂等保存。
- 新增 Meego 抓取总开关；关闭时不执行 Meego 同步。
- 新增 Q 标签过滤开关；开启时仅保留标签符合 `Q<季度><月><日>` 的未完成工作项，按完整标签分组并按标签时间排序；关闭时保留全部未完成参与工作项并按 `updated_at` 排序。
- 新增独立的 Meego 页面、同步状态和可操作错误展示，不把 Meego 的认证、限流和失败混入现有 Lark 同步状态。

## Capabilities

### New Capabilities
- `meego-context-sync`: 配置项目空间，通过 `meegle` CLI 只读发现、过滤、规范化、分页同步和持久化用户参与的 Meego 工作项。

### Modified Capabilities
- `context-workbench-ui`: 在 Settings 提供 Meego 抓取与 Q 标签过滤开关及项目空间配置，并新增按所选排序模式展示的 Meego 分类页面。

## Impact

- 新增 Meegle CLI runner、适配器、同步服务与独立同步 API。
- 扩展机器来源 provider/kind、同步状态类型和 Settings 持久配置。
- 修改服务装配、Web API、导航、Settings 与 Meego 列表页面。
- 增加 Meego 命令安全白名单、QPS 限流、分页、Q 标签解析、完成态归一化、幂等和 UI 测试。
- 运行环境需要已安装并登录 `meegle` CLI；不增加应用内写 Meego 的能力。
