## ADDED Requirements

### Requirement: 结构化人工确认
每个 Agent Turn SHALL 返回结构化 outcome；当 outcome 为 `needs_confirmation` 时，系统 MUST 持久化包含类型、问题、选项和来源 Turn 的 Confirmation Request，不得通过自然语言猜测确认状态。

传给 Codex Structured Outputs 的顶层字段 MUST 全部为 required；`confirmation` SHALL 通过对象或 `null` 的联合类型表达业务可选性。非 `needs_confirmation` 结果 MUST 返回 `confirmation: null`。

#### Scenario: Agent 请求方案选择
- **WHEN** Agent 返回合法的 `needs_confirmation` 结果和两个可选方案
- **THEN** 系统创建 `decision` 确认、将会话归入人工确认并展示问题与选项

### Requirement: 确认回答幂等且可审计
用户对 pending Confirmation 的批准、拒绝或文本回答 SHALL 原子保存回答者、答案和时间；重复回答 MUST 返回已有结果且不得触发重复 Turn。

#### Scenario: 重复提交相同确认
- **WHEN** 用户对已经回答的 Confirmation 再次提交答案
- **THEN** 系统返回现有终态且不会再次调用 Agent Runtime

### Requirement: 确认与普通回复分离
系统 SHALL 区分 `confirmation_required`、`reply_required` 和 `review_required`；普通 Agent 回复不得自动进入人工确认队列。

#### Scenario: Agent 等待补充信息
- **WHEN** Agent 返回 `awaiting_reply` 且没有 Confirmation 结构
- **THEN** 会话进入等待回复而不是人工确认分类

#### Scenario: Agent 等待完成验收
- **WHEN** Agent 返回 `completed`
- **THEN** 会话进入待验收分类且不复用动作批准状态

### Requirement: 回答后继续同一会话
有效 Confirmation 回答 SHALL 作为一条明确标注的用户消息追加到同一会话，并排队恢复同一 Codex Thread 的后续 Turn。

#### Scenario: 用户批准方案
- **WHEN** 用户批准一个 pending 决策确认
- **THEN** 系统保存回答并在同一会话中排队包含该决定的后续 Turn
