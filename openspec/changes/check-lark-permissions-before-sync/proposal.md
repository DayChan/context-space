## Why

当前系统只有在业务来源命令已经失败后才暴露飞书权限问题，首次同步会产生部分结果和分散错误，用户无法在发送任何业务数据请求前确认环境是否就绪。需要把 `lark-cli` 用户认证和最小只读 scope 检查前置为同步硬边界，并给出可直接执行的授权指引。

## What Changes

- 定义飞书同步所需的最小用户 scope，并通过 `lark-cli auth check --json` 执行无业务数据读取的权限预检。
- 每次手动或定时同步都先预检；首次同步缺少任一权限时不创建同步运行、不调用来源命令、不推进游标或提交分析任务。
- 为预检增加结构化状态 API，区分 CLI 缺失、认证不可用、scope 缺失和检查失败。
- Settings 在首次同步前展示权限状态、缺失 scope、授权命令和重新检查入口；系统只提醒，不自动发起授权。
- 已完成过同步的工作区在后续权限变化时继续保留现有来源级失败与成功来源提交语义，避免一次权限变化阻断全部增量采集。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `lark-context-sync`：增加同步前用户认证与最小 scope 预检、首次同步阻断及后续兼容语义。
- `context-workbench-ui`：增加 Settings 权限就绪状态、缺失权限指引和重新检查交互。

## Impact

- 影响 `src/adapters/lark` 的 CLI runner、同步服务和调度入口。
- 影响同步状态/API 契约、Settings 页面和相关测试。
- 不新增写飞书能力，不自动执行 `auth login`，不记录 token 或业务正文。
