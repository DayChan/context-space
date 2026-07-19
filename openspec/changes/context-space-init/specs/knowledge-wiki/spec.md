## ADDED Requirements

### Requirement: Typed knowledge documents
The system SHALL support project, decision, playbook, concept, glossary, and draft knowledge documents with stable IDs and source references.

#### Scenario: Capture a decision candidate
- **WHEN** analysis identifies a possible decision in source context
- **THEN** it creates a draft knowledge document with decision metadata and evidence links

### Requirement: Provenance and confidence
Generated knowledge MUST expose its source references, confidence, generated time, and curation state.

#### Scenario: View generated knowledge
- **WHEN** the user opens a generated knowledge page
- **THEN** the page displays its evidence and indicates whether it is draft or curated

### Requirement: Supersession history
The system SHALL preserve obsolete knowledge and represent replacement using explicit stale or superseded state and links.

#### Scenario: Replace an earlier decision
- **WHEN** a curated decision supersedes an existing decision
- **THEN** the earlier document remains readable and links to the replacing document

### Requirement: Work summaries
The system SHALL generate a Now summary and support dated daily and weekly summaries from current canonical Todo, calendar, mention, waiting, and knowledge data.

#### Scenario: Build the Now summary
- **WHEN** the workspace index is rebuilt
- **THEN** the Now summary reflects current top Todo items, upcoming calendar items, recent mentions, waiting items, review candidates, and knowledge changes

### Requirement: Knowledge search and backlinks
The system SHALL make knowledge content searchable and expose incoming references from Todo, people, source, and other knowledge documents.

#### Scenario: Search for a project term
- **WHEN** the user searches for a term contained in a project page
- **THEN** the matching knowledge document is returned with type and relevant metadata
