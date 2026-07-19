## ADDED Requirements

### Requirement: Visible Loop surface
The V1 UI SHALL include a Loop primary navigation item, a Now readiness card, and an Automation section on Todo details.

#### Scenario: Open Loop in V1
- **WHEN** the user visits the Loop route
- **THEN** the page explains future automation and clearly states that automatic execution is not enabled

### Requirement: Readiness categories
The Loop page SHALL present future-automatable, confirmation-required, blocked, and recent-run sections using current Todo automation metadata, with empty states when no data exists.

#### Scenario: Categorize a suggested Todo
- **WHEN** a Todo has automation mode `suggest` and requires confirmation
- **THEN** it appears in the confirmation-required readiness section

### Requirement: No V1 execution capability
V1 MUST NOT expose an execution endpoint, scheduler, enabled action button, or code path that invokes external tools from Todo automation metadata.

#### Scenario: Inspect Loop controls and API
- **WHEN** the V1 frontend and server routes are loaded
- **THEN** no control or API operation can start an automated Todo run

### Requirement: Safe future contract
Automation metadata SHALL include mode, handler, confirmation requirement, and allowed capabilities, and new Todo items SHALL default to a disabled and capability-empty state.

#### Scenario: Read an automation contract
- **WHEN** the UI loads a Todo without custom automation configuration
- **THEN** it displays disabled mode, required confirmation, and no allowed capabilities

### Requirement: Future audit placeholder
The workspace SHALL reserve Loop policy and run-history locations without recording fabricated runs.

#### Scenario: Initialize Loop storage
- **WHEN** a workspace is initialized
- **THEN** policy documentation and an empty run-history location exist while the recent-run UI shows an honest empty state
