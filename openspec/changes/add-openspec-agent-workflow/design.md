## Context

人工 Agent Loop 已将 Session、Turn、Message、Event、Confirmation 和隔离 worktree 分层持久化，但 Session 只记录读写模式，没有上层开发工作流。OpenSpec 1.3.1 提供实验性的 schema artifact graph、change metadata、`list/status/instructions/schema which` JSON 接口；其中 `status` 根据 schema 的 `generates` 路径与实际文件存在性计算完成状态。

该功能跨越 Agent 启动事务、Git worktree、外部 CLI、SQLite migration、Codex skill 调用、SSE 失效通知和 Loop UI。所有 OpenSpec 写入必须留在会话 worktree，不能污染注册仓库主工作区。

## Goals / Non-Goals

**Goals:**

- 为隔离开发会话增加持久、可恢复的 OpenSpec 工作流类型。
- 在缺失 OpenSpec 时通过显式确认完成原子化初始化，失败无残留会话。
- 以 OpenSpec CLI 与 schema 为真相展示任意 schema 的 artifact DAG 和实际 Markdown 进度。
- 通过 Agent skills 创建和推进多个 change，并保持同一 Codex Thread 上下文。
- 保持现有 CSRF、路径边界、参数化子进程和保守 worktree 清理约束。

**Non-Goals:**

- 为每个 change 创建独立 worktree、分支、Codex Thread 或验收生命周期。
- 自动生成 proposal/spec/design/tasks，或在 workflow 节点完成后自动调用下一 Skill。
- 自动提交、合并、push、archive 或 sync OpenSpec change。
- 重新实现 OpenSpec 对 artifact 完成状态和 schema 解析的语义。

## Decisions

### 将工作流类型与工作区模式正交建模

在 `agent_sessions` 增加 `workflow_kind`，取值为 `direct` 或 `openspec`，默认 `direct` 以兼容历史记录。启动 API 使用带 `initializeIfMissing` 的 OpenSpec 配置，并在服务端强制 `openspec + isolated_worktree + git` 组合，避免 UI 绕过约束。

### 初始化采用延迟持久化和补偿回滚

Readiness API 在注册仓库路径检查 `openspec/config.yaml`、change 目录和必要 Codex skills。用户同意初始化后，服务先创建 session ID 对应的临时 worktree，再以参数数组运行 `openspec init <worktree> --tools codex --force`。只有初始化和二次 readiness 校验成功后才事务写入 Session、首条 Message 与 Turn；失败则强制移除刚创建的 worktree 和分支。

项目级 skill discovery 同时接受 `.codex/skills/<name>/SKILL.md` 与通用的 `.agents/skills/<name>/SKILL.md`。readiness 按 skill 逐个检查两个根目录，任一位置存在即满足要求；这允许仓库只跟踪通用 `.agents` 目录，也允许迁移期间混合存放。初始化仍使用 Codex 工具参数生成 `.codex`，但初始化后的校验遵循相同的双目录规则。

相比在原仓库执行 init，该方案保证生成文件实际存在于 Agent 工作目录，并随会话分支接受或清理。相比先持久化 Session 再初始化，该方案不会留下没有首轮执行能力的幽灵会话。

### 服务端规范化首条 Skill Prompt

OpenSpec 会话由服务端为首条 Prompt 添加 `$openspec-explore`，并识别 `$openspec-explore` 与 `/openspec-explore` 前缀以保证幂等。后续“新建 Change”使用专用 API 校验 change 名称后排队 `$openspec-new-change <name>` Turn，而不是由服务端直接运行 `openspec new change`，从而保留 Skill 的交互和 Codex 对话上下文。

### 以 OpenSpecInspector 形成兼容边界

新增可注入 `OpenSpecRunner`，只允许预定义参数数组并限制 cwd、超时与输出大小。Inspector 使用：

- `openspec list --json` 获取 active changes；
- `openspec status --change <name> --json` 获取 schema、输出路径和实际状态；
- `openspec schema which <schema> --json` 解析 package 或 project-local schema 位置；
- 读取并严格校验 `schema.yaml` 获取 artifact 描述和 `requires` 边。

API 只返回工作区相对路径，不泄露 schema package 的任意绝对路径。schema 解析失败只影响 workflow 投影，不影响对话与会话恢复。

### Change 状态从工作区派生而非复制到 SQLite

`workflow_kind` 属于会话规范状态，change 名称、schema、artifact 输出和进度属于 worktree 文件投影，不复制到 SQLite。当前 change 选择保留在前端会话状态；刷新时默认选择最近修改的 change。新建多个 change 共享 Session、Thread、branch 和最终验收，UI 明确展示该约束。

### Workflow 使用按需详情与 SSE 失效刷新

列表 API 返回 change 摘要，详情 API 只解析当前选中 change 的 schema DAG，避免每次 SSE 对所有 change 启动多个 CLI 进程。Agent 文件事件、Turn 完成或手动创建请求触发客户端重新读取列表与当前详情。UI 在固定高度会话区内使用紧凑横向 DAG/节点列表，不挤占消息区的独立滚动能力。

## Risks / Trade-offs

- **[OpenSpec schema 命令为实验接口]** → 将所有 CLI JSON 和 YAML 校验集中在 `OpenSpecInspector`，错误转换为稳定领域错误，避免组件直接依赖 CLI 文本。
- **[OpenSpec init 可能生成 Codex 全局 prompt]** → 确认界面说明初始化范围；服务仍只传固定 `--tools codex --force` 参数，不接受任意工具或命令输入。
- **[文件存在不代表 artifact 内容有效]** → workflow 进度保持与 `openspec status` 一致；内容 validation 作为未来独立状态，不混淆当前完成语义。
- **[多个 change 共享工作区导致验收耦合]** → UI 标注共享 Session/worktree；需要独立合并时要求新建 Agent Session，而不是在本 change 内引入嵌套 worktree。
- **[初始化后数据库写入失败]** → 启动服务捕获错误并补偿删除临时 worktree；若补偿失败记录结构化诊断并保留路径供人工恢复。
- **[主工作区存在 ignored `.codex`，隔离 worktree 仅继承 tracked `.agents`]** → readiness 同时识别两个标准 skill 根目录，并通过真实 Git worktree 回归测试保证前后判断一致。
- **[频繁 SSE 造成 CLI 风暴]** → change 列表和选中详情分离，前端去抖刷新，后端对 schema 定义按路径与 mtime 缓存。

## Migration Plan

1. 增加 `workflow_kind` migration，历史 Session 自动为 `direct`。
2. 引入可注入 OpenSpec runner/inspector 与 readiness API，不改变现有直接会话。
3. 扩展启动 API、服务事务和补偿清理，完成后开放 UI 勾选项。
4. 增加 change/workflow API 和 Loop UI，保留 OpenSpec CLI 不可用时的局部错误展示。
5. 回滚旧版本时新增列保留；OpenSpec worktree 仍可作为普通隔离会话查看和人工清理。

## Open Questions

- 当前版本按用户要求允许同一会话包含多个 change，并采用 Session 级统一验收；change 级独立验收留待后续需求。
- Artifact 内容 validation、继续 change 和 apply/verify 快捷按钮不在本次范围，workflow 只反映 OpenSpec 自身 status。
