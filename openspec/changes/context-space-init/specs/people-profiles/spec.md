## ADDED Requirements

### Requirement: Stable source-neutral identity
The system SHALL create an internal stable person ID and associate it with one or more provider identities without using display names as primary keys.

#### Scenario: Discover a Lark participant
- **WHEN** a previously unknown Lark open ID appears in relevant context
- **THEN** one person profile is created and subsequent occurrences update that profile rather than creating duplicates

### Requirement: Evidence-backed profile content
Profiles SHALL distinguish directory facts, manual notes, and generated workplace observations, and generated observations MUST include evidence, confidence, and update time.

#### Scenario: Add a collaboration observation
- **WHEN** analysis infers a work collaboration preference from captured messages
- **THEN** the observation is labeled as inferred and links to its supporting source records

### Requirement: Sensitive inference prohibition
The system MUST NOT generate protected or sensitive personal attributes from work context.

#### Scenario: Analyze unrelated sensitive language
- **WHEN** a source message contains language that could imply a sensitive personal attribute
- **THEN** no corresponding profile trait is created

### Requirement: Computed mutual commitments
The system SHALL compute what the user owes a person and what is waiting on that person from canonical Todo stakeholder references.

#### Scenario: View a person's commitments
- **WHEN** a person is a stakeholder on one `owed_by_me` and one `waiting_on_them` Todo
- **THEN** the profile view lists each Todo in the appropriate computed section without duplicating Todo state

### Requirement: Manual Leader designation
Only an explicit user configuration SHALL designate a person as a Leader and define their priority boost.

#### Scenario: Mark a person as Leader
- **WHEN** the user saves a Leader configuration for a stable person ID
- **THEN** the profile shows the designation and eligible Todo priority calculations use the configured boost
