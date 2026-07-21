# Markdown 上下文存储规范

## Purpose

本规范用于定义以版本化 Markdown 作为人工 Todo、人物备注和知识文档规范真相的工作区布局、类型化元数据、安全原子持久化、可重建索引和用户所有权规则；机器数据的规范真相由 SQLite 承担。

## Requirements

### Requirement: 工作区布局初始化
系统 SHALL 初始化已配置的工作区，并为人工 Todo、人物备注、分类知识和内部 SQLite 状态创建独立位置；系统 MUST NOT 要求飞书来源、候选、分析运行或同步检查点使用 Markdown 目录。

#### Scenario: 初始化空工作区
- **WHEN** 应用使用一个可写的空工作区路径启动
- **THEN** 系统创建人工内容目录和内部数据库，第二次启动时不会产生重复内容

### Requirement: 版本化 Markdown 文档
系统 SHALL 仅将人工维护的 Todo、人物备注和知识文档作为规范 Markdown，并使用版本化 YAML frontmatter 记录稳定 ID、类型、时间戳、适用时的候选 ID 和来源引用。

#### Scenario: 读写 Todo 文档
- **WHEN** 保存并随后加载一份有效的人工 Todo 文档
- **THEN** 系统返回相同的类型化元数据和 Markdown 正文，且稳定 ID 保持不变

### Requirement: 安全的原子持久化
系统 MUST 将文档路径限制在工作区根目录内、拒绝路径穿越，并以原子方式替换文档。

#### Scenario: 拒绝不安全路径
- **WHEN** 调用方尝试读写逃逸出工作区根目录的路径
- **THEN** 操作失败，且不会在工作区外创建或修改文件

#### Scenario: 替换有效文档
- **WHEN** 有效的文档更新成功
- **THEN** 读取方只能观察到之前的完整文件或新的完整文件，并且不会残留临时文件

### Requirement: 可重建索引
系统 SHALL 完全根据规范人工 Markdown 构建其搜索和反向链接投影，并允许删除 SQLite 索引投影后重建而不影响机器规范数据。

#### Scenario: 删除缓存后重建
- **WHEN** 删除生成的 Markdown 索引状态并请求重建
- **THEN** 系统恢复人工文档的搜索和反向链接投影，且不改变规范 Markdown

### Requirement: 管理模式保护
系统 MUST 将规范 Markdown 视为用户拥有内容；机器分析不得直接刷新或覆盖人工字段和正文，只能通过用户接受候选创建新文档。

#### Scenario: 分析已有人工人物备注
- **WHEN** 分析器生成与包含用户编辑字段的人物备注相关的新观察
- **THEN** 系统只创建待审核候选，用户拥有的字段与正文保持不变

#### Scenario: 分析产生人物洞察
- **WHEN** 分析器生成与已有人工人物备注相关的新观察
- **THEN** 系统创建待审核候选，已有 Markdown 保持不变
