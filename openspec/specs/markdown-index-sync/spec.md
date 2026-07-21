# Markdown 索引同步规范

## Purpose

本规范用于定义人工 Markdown 的版本兼容、启动全量校准、文件监听增量更新、定期低频校准和非法文档隔离。

## Requirements

### Requirement: 版本化 Schema Registry
系统 MUST 根据 Markdown `schema` 字段选择对应的严格运行时解析器并转换为当前领域模型；读取旧版本时 MUST NOT 静默改写磁盘内容。

#### Scenario: 读取受支持的旧版本
- **WHEN** 工作区包含一个仍受支持的旧版本 Todo
- **THEN** 系统将其转换为当前只读领域模型，且文件字节保持不变

#### Scenario: 读取未知新版本
- **WHEN** 文档声明当前应用未知的更高 Schema 版本
- **THEN** 系统将其报告为只读诊断，并拒绝用旧 Schema 覆盖

### Requirement: 多层索引校准
系统 SHALL 在启动时全量校准 Markdown 索引、运行时监听文件变化进行单文件增量更新，并定期使用文件摘要执行低频校准。

#### Scenario: 外部编辑 Todo
- **WHEN** 用户在外部编辑器保存一个有效 Todo Markdown
- **THEN** 系统在不全量重建的情况下更新该文档的搜索与反向链接投影

#### Scenario: 文件监听事件丢失
- **WHEN** 文件发生变化但监听器未收到事件
- **THEN** 后续定期校准根据摘要差异更新索引

### Requirement: 非法文档隔离
单个非法或无法读取的 Markdown MUST NOT 清空或阻塞其他有效文档的索引；系统 SHALL 保留该路径上一次有效投影并报告诊断。

#### Scenario: 全量校准遇到坏文件
- **WHEN** 启动扫描中一个人物文档缺少必填字段
- **THEN** 其他有效文档全部进入新索引 generation，坏文件产生独立诊断
