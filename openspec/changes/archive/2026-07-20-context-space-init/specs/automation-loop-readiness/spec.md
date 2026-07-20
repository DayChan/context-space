## ADDED Requirements

### Requirement: 可见的 Loop 界面
V1 UI SHALL 包含 Loop 主导航项、Now 就绪度卡片，以及 Todo 详情中的自动化区域。

#### Scenario: 在 V1 中打开 Loop
- **WHEN** 用户访问 Loop 路由
- **THEN** 页面说明未来的自动化能力，并明确表示自动执行尚未启用

### Requirement: 就绪度分类
Loop 页面 SHALL 根据当前 Todo 自动化元数据展示未来可自动化、需要确认、已阻塞和近期运行区域；没有数据时展示空状态。

#### Scenario: 对建议状态的 Todo 分类
- **WHEN** Todo 的自动化模式为 `suggest` 且需要确认
- **THEN** 该 Todo 出现在“需要确认”的就绪度区域

### Requirement: V1 不具备执行能力
V1 MUST NOT 暴露执行端点、调度器、已启用的动作按钮，或根据 Todo 自动化元数据调用外部工具的代码路径。

#### Scenario: 检查 Loop 控件和 API
- **WHEN** 加载 V1 前端和服务端路由
- **THEN** 不存在能够启动自动化 Todo 运行的控件或 API 操作

### Requirement: 安全的未来契约
自动化元数据 SHALL 包含模式、处理器、确认要求和允许的能力；新 Todo SHALL 默认处于禁用且能力列表为空的状态。

#### Scenario: 读取自动化契约
- **WHEN** UI 加载一个没有自定义自动化配置的 Todo
- **THEN** 页面展示禁用模式、必须确认以及没有允许能力的状态

### Requirement: 未来审计占位
工作区 SHALL 预留 Loop 策略和运行历史位置，但不得记录虚构的运行。

#### Scenario: 初始化 Loop 存储
- **WHEN** 工作区完成初始化
- **THEN** 策略文档和空的运行历史位置已经存在，同时近期运行 UI 如实展示空状态
