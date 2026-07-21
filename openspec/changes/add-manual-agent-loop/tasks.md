## 1. 持久模型与仓库工作区

- [x] 1.1 新增 Agent 仓库、会话、Turn、消息、事件和人工确认的 SQLite migration 与类型化 Repository
- [x] 1.2 实现 Git 仓库注册、规范路径校验和只读仓库元数据查询
- [x] 1.3 实现会话专属 worktree 创建、只读升级、状态检查和保守清理

## 2. Agent Runtime 与会话协调

- [x] 2.1 定义可注入的 Agent Runtime 端口、结构化终态 Schema 和 Fake Runtime 测试接口
- [x] 2.2 实现 Codex SDK 流式 Runtime，按工作模式设置目录、沙箱、网络与审批策略
- [x] 2.3 实现 Agent Coordinator 的异步串行 Turn、事件持久化、取消、中断恢复和 SSE 通知
- [x] 2.4 实现结构化人工确认、幂等回答、同 Thread 继续和完成验收状态

## 3. 本地 API

- [x] 3.1 增加仓库注册、列表和移除 API，并接入现有 CSRF 与错误处理
- [x] 3.2 增加会话启动、列表、详情、消息、确认、停止、验收、工作区升级与清理 API
- [x] 3.3 增加 Loop SSE 端点和真实会话投影，保留自动化 readiness 为独立摘要

## 4. 工作台界面

- [x] 4.1 在 Todo 与 Meego 可执行条目增加 Agent 启动面板，支持编辑说明、选择仓库与工作模式
- [x] 4.2 将 Loop 页面升级为会话列表、实时对话、人工确认和工作上下文三栏工作台
- [x] 4.3 在 Settings 增加仓库注册与移除界面，并处理无仓库、校验失败和活跃引用状态

## 5. 验证与文档

- [x] 5.1 增加 Repository、worktree、Coordinator、恢复与确认状态的单元和集成测试
- [x] 5.2 增加 Agent API、SSE、Todo/Meego 启动、Loop 对话与 Settings 仓库交互测试
- [x] 5.3 更新 README 的人工 Loop、工作模式、安全边界、worktree 生命周期和恢复说明
- [x] 5.4 执行类型检查、Lint、完整测试与生产构建并修复全部问题

## 6. 普通目录与主目录路径

- [x] 6.1 扩展工作目录模型与 migration，支持 Git/普通目录类型、可空 Git 元数据和 `~/` 路径展开
- [x] 6.2 限制普通目录仅能启动只读会话，并在 Settings 与启动面板展示能力差异
- [x] 6.3 增加普通目录、`~/` 展开、隔离模式拒绝测试并执行完整校验

## 7. 结构化输出与失败可观测性

- [x] 7.1 修复 Codex Structured Output Schema，以 nullable confirmation 表达可选确认并增加契约测试
- [x] 7.2 在 Loop 展示失败、中断和取消 Turn 的错误，执行完整校验并提交修复

## 8. Loop 时间线与布局一致性

- [x] 8.1 将消息、工具事件和 Turn 异常合并为按时间排序的对话时间线
- [x] 8.2 统一会话选择项与启动面板控件宽度，增加前端回归测试并执行完整校验
