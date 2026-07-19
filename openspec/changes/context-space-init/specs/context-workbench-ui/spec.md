## ADDED Requirements

### Requirement: Stable primary navigation
The Web UI SHALL expose primary routes for Now, Inbox, Todos, People, Knowledge, Timeline, Loop, and Settings.

#### Scenario: Navigate across the workbench
- **WHEN** the user selects each primary navigation item
- **THEN** the corresponding page loads locally without a full page reload

### Requirement: Now dashboard
The Now page SHALL display top Todo items with priority reasons, upcoming calendar items, recent mentions, waiting items, review candidates, knowledge changes, and Loop readiness.

#### Scenario: Render current work
- **WHEN** indexed workspace data contains each supported overview category
- **THEN** the Now page renders each category and links entries to their detailed views

### Requirement: Browsing and filtering
The UI SHALL allow users to browse and filter Todo, people, knowledge, Inbox, and timeline data and perform full-text search.

#### Scenario: Filter Todo by direction
- **WHEN** the user selects the waiting-on-others filter
- **THEN** only Todo items with direction `waiting_on_them` are displayed

### Requirement: Provenance-aware detail views
Detail views SHALL display management mode, source references, confidence where applicable, and generated versus user-owned content.

#### Scenario: View a hybrid document
- **WHEN** the user opens a hybrid profile or Todo
- **THEN** the UI visually distinguishes editable user content from generated evidence-backed content

### Requirement: Local safe editing
The UI SHALL save supported edits through the local API using optimistic concurrency and SHALL report stale-write conflicts without overwriting newer content.

#### Scenario: Submit a stale edit
- **WHEN** a document changed after the user loaded it
- **THEN** the API rejects the stale update and the UI asks the user to reload or reconcile

### Requirement: Synchronization visibility
Settings and Now SHALL expose Lark availability, last-run status, per-source results, and a manual read-only synchronization trigger.

#### Scenario: Display a partial sync failure
- **WHEN** a synchronization completes with one failed source
- **THEN** successful counts and the failed source message are both visible
