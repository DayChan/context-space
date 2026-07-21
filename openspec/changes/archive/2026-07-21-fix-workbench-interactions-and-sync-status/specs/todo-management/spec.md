## MODIFIED Requirements

### Requirement: 生命周期与承诺方向
每个 Todo MUST 记录受支持的生命周期状态，并说明该事项由用户负责、正在等待他人，还是共同负责。用户 SHALL 能通过工作台把 Todo 标记为完成或重新打开，且后续只读来源同步 MUST 保留用户维护的状态。

#### Scenario: 跟踪等待他人的工作
- **WHEN** 一条已确认 Todo 的方向为 `waiting_on_them`
- **THEN** 该 Todo 出现在等待视图中，并从用户的直接执行队列中排除

#### Scenario: 标记 Todo 已完成
- **WHEN** 用户在工作台点击一条开放 Todo 的完成控件
- **THEN** 系统持久化完成状态并立即在界面中展示更新结果

#### Scenario: 同步后保留本地状态
- **WHEN** 用户已在本地标记原生任务 Todo 为完成，随后再次执行只读飞书同步
- **THEN** 系统保留该 Todo 的本地完成状态而不把它重置为开放
