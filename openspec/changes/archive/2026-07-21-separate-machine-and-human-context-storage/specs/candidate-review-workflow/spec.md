## ADDED Requirements

### Requirement: 所有模型结果必须审核
系统 MUST 将 LLM 生成的 Todo、知识和人物洞察保存为 SQLite 候选，并 MUST NOT 根据置信度自动创建或修改人工 Markdown。

#### Scenario: 高置信度行动项
- **WHEN** LLM 返回置信度达到最大值的明确行动项
- **THEN** 系统仍将其展示为待审核候选，直到用户接受

### Requirement: 接受操作可恢复
系统 SHALL 使用 `pending`、`materialized`、`accepted` 和 `conflict` 状态记录候选接受操作，并以候选 ID 派生确定性文档 ID 和 Markdown 路径。

#### Scenario: Markdown 创建后进程退出
- **WHEN** 系统已物化候选 Markdown，但在提交 `accepted` 前退出
- **THEN** 启动恢复验证文件身份并完成接受状态，而不创建第二份文档

#### Scenario: 确定性路径存在冲突文件
- **WHEN** 目标路径存在但文档 ID 或 `candidate_id` 与当前候选不匹配
- **THEN** 系统将接受操作标记为 `conflict`，保留现有文件且不覆盖

### Requirement: 接受与拒绝幂等
系统 MUST 保证重复接受或拒绝同一候选不会创建重复文档或产生矛盾终态。

#### Scenario: 重复提交接受请求
- **WHEN** 用户对已经接受的候选再次提交接受请求
- **THEN** 系统返回现有人工文档关联，且不修改文档身份

### Requirement: 最小审核依据
候选 SHALL 展示来源引用、必要证据摘录、置信度、Provider、Prompt 版本和分析时间；系统 MUST NOT 展示内部推理或凭证。

#### Scenario: 审核知识候选
- **WHEN** 用户打开一条知识候选
- **THEN** UI 展示足以判断是否接受的最小证据和来源元数据
