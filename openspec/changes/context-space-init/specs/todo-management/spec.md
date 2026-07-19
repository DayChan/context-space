## ADDED Requirements

### Requirement: Todo source handling
The system SHALL create authoritative Todo items from native Lark tasks and reviewable candidates from non-native context unless an explicit action meets the configured confidence threshold.

#### Scenario: Import a native task
- **WHEN** a new incomplete Lark task is synchronized
- **THEN** an open Todo with a stable source reference and upstream status ownership is created or updated

#### Scenario: Detect an ambiguous chat action
- **WHEN** a message suggests work but does not meet the explicit-action threshold
- **THEN** a candidate is placed in Inbox and does not appear as a confirmed high-priority Todo

### Requirement: Lifecycle and commitment direction
Each Todo MUST record a supported lifecycle status and whether it is owed by the user, waiting on another person, or shared.

#### Scenario: Track work waiting on another person
- **WHEN** a confirmed Todo has direction `waiting_on_them`
- **THEN** it appears in waiting views and is excluded from the user's direct execution queue

### Requirement: Explainable priority
The system SHALL compute priority from a base score and named boosts for urgency, explicit assignment, staleness, and Leader involvement, with a user-set manual priority taking precedence.

#### Scenario: Apply a Leader boost
- **WHEN** an open `owed_by_me` Todo references a manually configured Leader
- **THEN** its effective priority increases and the result includes a visible Leader reason

#### Scenario: Preserve manual priority
- **WHEN** a Todo has a manual priority override
- **THEN** sorting uses the manual value while retaining automatic reasons for explanation

### Requirement: Todo provenance
Every non-manual Todo SHALL retain at least one resolvable source reference and expose it in the API and UI.

#### Scenario: Open Todo evidence
- **WHEN** the user views a Todo derived from a Lark mention
- **THEN** the Todo displays a reference to the captured mention document

### Requirement: Automation metadata
Every Todo SHALL expose an automation block whose default mode is disabled.

#### Scenario: Create a new Todo
- **WHEN** a Todo is created without explicit automation settings
- **THEN** its mode is `disabled`, confirmation is required, and no capabilities are allowed
