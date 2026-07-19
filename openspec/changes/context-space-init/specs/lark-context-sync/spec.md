## ADDED Requirements

### Requirement: Read-only user identity
The Lark adapter MUST invoke supported retrieval commands with user identity and MUST NOT invoke Lark mutation commands.

#### Scenario: Build a synchronization run
- **WHEN** a user starts a Lark synchronization
- **THEN** every generated command uses `--as user` and belongs to the configured read-only command allowlist

### Requirement: Relevant context collection
The adapter SHALL collect group messages that mention the user, both sides of P2P conversations, calendar events in the configured rolling window, and tasks assigned to the user.

#### Scenario: Synchronize all enabled Lark sources
- **WHEN** all Lark commands return valid records
- **THEN** the system writes normalized mention, P2P, calendar, and task source Markdown documents with provider-stable source IDs

### Requirement: Incremental and idempotent synchronization
The adapter SHALL use checkpoints, an overlap window, pagination, and stable source IDs so repeated runs do not create duplicate records.

#### Scenario: Repeat an overlapping run
- **WHEN** a second run returns records already captured by the first run plus one new record
- **THEN** existing records are updated or skipped and exactly one new canonical source record is created

### Requirement: Bounded backfill
The adapter SHALL split initial message backfill into configurable time windows and surface whether pagination or a page cap left a window incomplete.

#### Scenario: Backfill exceeds one result window
- **WHEN** an initial date range spans multiple configured windows
- **THEN** the adapter requests each window separately and advances the checkpoint only for completed windows

### Requirement: Failure isolation and status
The adapter SHALL report per-source success, failure, counts, timestamps, and actionable error messages without discarding previously valid checkpoints.

#### Scenario: Calendar retrieval fails
- **WHEN** messages and tasks succeed but the calendar command fails
- **THEN** successful sources are persisted, calendar failure is shown in sync status, and the calendar checkpoint is not advanced
