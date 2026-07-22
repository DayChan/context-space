## ADDED Requirements

### Requirement: 同步前最小权限预检
系统 SHALL 在飞书同步读取任何业务来源前，通过用户身份检查 `auth:user.id:read`、`search:message`、`calendar:calendar.event:read` 和 `task:task:read` 四项最小 scope，并 SHALL 返回 CLI 可用性、认证状态、已授予 scope、缺失 scope、检查时间和仅包含缺失 scope 的授权命令。系统 MUST NOT 自动执行登录、授权或权限变更。

#### Scenario: 首次同步权限齐全
- **WHEN** 工作区尚无完整成功的飞书同步，且预检确认用户 token 有效并授予全部最小 scope
- **THEN** 系统开始现有五个来源的只读同步，并正常创建同步运行、推进成功游标和提交分析任务

#### Scenario: 首次同步缺少权限
- **WHEN** 工作区尚无完整成功的飞书同步，且预检返回一个或多个缺失 scope
- **THEN** 系统阻止本次同步，不创建同步运行、不调用任何业务来源命令、不推进游标或提交分析任务，并返回缺失 scope 与人工授权命令

#### Scenario: 后续同步权限被撤销
- **WHEN** 工作区已经完成过一次完整成功同步，但后续预检发现 scope 缺失
- **THEN** 系统保留预检告警并继续现有来源级同步，成功来源正常提交，实际失败来源按结构化权限错误隔离且不推进其游标

#### Scenario: CLI 或认证不可用
- **WHEN** 权限预检找不到 `lark-cli`、用户身份未登录、token 无效或检查命令无法解析
- **THEN** 系统返回对应的安装、认证或检查失败状态与人工处理提示，且首次同步不发送业务数据请求
