## 1. 会话模型与 OpenSpec 基础设施

- [x] 1.1 增加 `workflow_kind` 类型、SQLite migration、Repository 映射和兼容默认值
- [x] 1.2 实现可注入且受限的 OpenSpec CLI runner、readiness 检查和错误边界
- [x] 1.3 实现 change 列表、schema DAG 解析和 artifact status 工作流投影

## 2. 会话创建与 Change 操作

- [x] 2.1 扩展 Agent 启动契约，校验 OpenSpec 仅用于 Git 隔离开发并规范化首轮探索 Prompt
- [x] 2.2 实现 worktree 内 OpenSpec 初始化、成功后持久化和失败补偿清理
- [x] 2.3 增加 readiness、change 列表、workflow 详情和 `$openspec-new-change` 排队 API

## 3. 工作台交互

- [x] 3.1 扩展 Agent 启动面板，支持 OpenSpec 勾选、readiness 状态和初始化确认
- [x] 3.2 在 Loop 会话中实现新建 Change、下拉切换和 schema workflow 节点展示
- [x] 3.3 根据 SSE 会话事件刷新 OpenSpec change 与 workflow，同时保持固定会话滚动布局

## 4. 验证与文档

- [x] 4.1 增加 OpenSpec runner、初始化回滚、Prompt、API 与多 change 工作流后端测试
- [x] 4.2 增加启动确认、change 创建切换和 workflow 状态前端回归测试
- [x] 4.3 更新 README 并执行类型检查、Lint、完整测试与生产构建

## 5. Agent Skills 目录兼容

- [x] 5.1 readiness 支持从 `.codex/skills` 或 `.agents/skills` 逐项发现必需 skill，并增加隔离 worktree 回归测试与文档
