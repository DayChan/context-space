## ADDED Requirements

### Requirement: 显式仓库注册
系统 SHALL 仅允许注册存在且可解析的 Git 仓库根目录，保存规范真实路径与 Git 元数据，并 MUST 拒绝重复真实路径和非 Git 目录。

#### Scenario: 注册有效仓库
- **WHEN** 用户提交一个存在的 Git 仓库路径
- **THEN** 系统解析仓库顶层目录和当前 HEAD，保存唯一仓库并在启动面板提供选择

#### Scenario: 注册普通目录
- **WHEN** 用户提交的路径不是 Git 仓库
- **THEN** 系统拒绝注册且不创建仓库记录

### Requirement: 只读分析模式
只读 Agent 会话 SHALL 直接使用注册仓库根目录并强制使用只读沙箱；系统 MUST NOT 为该模式创建分支、worktree 或写权限。

#### Scenario: 启动只读分析
- **WHEN** 用户选择 `read_only` 模式启动会话
- **THEN** Runtime 使用仓库根目录和只读沙箱，仓库文件不可被 Agent 修改

### Requirement: 隔离开发模式
隔离开发会话 SHALL 固定启动时的 `base_commit`，创建会话专属分支和位于 Context Space 管理目录中的 Git worktree，并将 Agent 写权限限制在该 worktree。

#### Scenario: 启动隔离开发
- **WHEN** 用户选择 `isolated_worktree` 模式且 worktree 创建成功
- **THEN** 系统保存基线、分支和工作区路径，并只在该路径启动可写 Agent

#### Scenario: worktree 创建失败
- **WHEN** Git 无法创建分支或 worktree
- **THEN** 系统不启动 Agent、不降级到原仓库可写模式，并返回可操作错误

### Requirement: 从只读升级到隔离开发
只读会话需要写入时 SHALL 创建人工确认；只有用户批准后系统才能从原 `base_commit` 创建独立 worktree、记录工作区切换事件并在后续 Turn 使用新工作区。

#### Scenario: 批准写入升级
- **WHEN** 用户批准只读会话的写入请求且 worktree 创建成功
- **THEN** 会话切换为隔离开发工作区，原仓库仍未被 Agent 写入

### Requirement: 保守清理工作区
系统 MUST 在删除 worktree 前检查未提交修改和未合并提交；存在任一情况时必须获得单独人工确认，未确认或清理失败时 SHALL 保留工作区和分支。

#### Scenario: 清理含修改的 worktree
- **WHEN** 用户请求清理且 worktree 包含未提交修改
- **THEN** 系统创建清理确认请求，不执行删除

#### Scenario: 清理干净且已确认的 worktree
- **WHEN** worktree 安全检查通过且用户确认删除
- **THEN** 系统通过 Git worktree 操作删除工作区并更新其生命周期状态
