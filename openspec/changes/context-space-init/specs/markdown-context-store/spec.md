## ADDED Requirements

### Requirement: Workspace layout initialization
The system SHALL initialize the configured workspace with separate locations for configuration, Lark sources, Inbox candidates, Todo items and views, people, typed knowledge, summaries, Loop policy placeholders, and internal sync state.

#### Scenario: Initialize an empty workspace
- **WHEN** the application starts with a writable empty workspace path
- **THEN** it creates every required directory and baseline configuration document without creating duplicate content on a second start

### Requirement: Versioned Markdown documents
The system SHALL store canonical business records as Markdown with versioned YAML frontmatter containing a stable ID, type, management mode, timestamps, and source references where applicable.

#### Scenario: Read and write a Todo document
- **WHEN** a valid Todo document is saved and then loaded
- **THEN** the system returns the same typed metadata and Markdown body with its stable ID unchanged

### Requirement: Safe atomic persistence
The system MUST constrain document paths to the workspace root, reject path traversal, and replace documents atomically.

#### Scenario: Reject an unsafe path
- **WHEN** a caller attempts to read or write a path that escapes the workspace root
- **THEN** the operation fails without creating or modifying a file outside the workspace

#### Scenario: Replace a valid document
- **WHEN** a valid document update succeeds
- **THEN** readers observe either the previous complete file or the new complete file and no temporary file remains

### Requirement: Rebuildable index
The system SHALL build search and backlink results entirely from canonical Markdown documents.

#### Scenario: Rebuild after cache removal
- **WHEN** generated index state is removed and a rebuild is requested
- **THEN** searchable documents and source-reference backlinks are restored without changing canonical Markdown

### Requirement: Management mode protection
The system MUST preserve user-owned fields and content when processing `manual` or `hybrid` documents.

#### Scenario: Refresh a hybrid profile
- **WHEN** an analyzer refreshes a hybrid profile containing user-edited fields
- **THEN** generated observations may change but user-owned values remain unchanged
