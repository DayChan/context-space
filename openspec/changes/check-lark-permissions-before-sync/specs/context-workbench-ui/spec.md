## ADDED Requirements

### Requirement: 飞书权限就绪状态
Settings SHALL 在飞书来源区域展示同步所需最小 scope 的预检状态，并 SHALL 提供重新检查入口。缺少权限时界面 MUST 展示缺失 scope 和仅包含缺失 scope 的 `lark-cli auth login --scope` 命令；界面 MUST NOT 自动执行授权。

#### Scenario: 首次同步前权限缺失
- **WHEN** 用户进入尚未完成首次同步的 Settings，且预检返回缺失 scope
- **THEN** 页面展示需要开通的权限与授权命令，禁用或拦截“立即只读同步”，并允许用户授权后重新检查

#### Scenario: 权限检查通过
- **WHEN** 预检确认全部最小 scope 已授予
- **THEN** 页面显示飞书权限已就绪，并允许用户启动首次同步

#### Scenario: 后续权限发生变化
- **WHEN** 工作区已完成首次同步且新的预检返回缺失 scope
- **THEN** 页面继续显示明确告警与授权命令，但保留同步入口以沿用来源级故障隔离
