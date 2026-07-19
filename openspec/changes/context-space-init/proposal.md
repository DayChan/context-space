## Why

Work context is fragmented across Lark mentions, direct messages, calendar events, and tasks, which makes commitments, current priorities, people knowledge, and durable work knowledge difficult to maintain. A local-first, Markdown-based context space is needed now to turn those sources into a traceable personal work wiki while establishing safe boundaries for future automated execution.

## What Changes

- Introduce a local-first workspace where Markdown files are the canonical source of truth and any search index is rebuildable.
- Add a read-only Lark adapter that incrementally captures group mentions, direct messages, calendar events, tasks, and discovered people through `lark-cli --as user`.
- Normalize captured context into source documents with stable IDs, provenance, sync checkpoints, deduplication, and bounded context expansion.
- Extract and manage Todo items, including candidate review, commitment direction, explainable priority scoring, and configurable Leader boosts.
- Build evidence-backed people profiles and computed views of what the user owes each person and what is waiting on them.
- Extract work knowledge into project, decision, playbook, concept, glossary, and draft documents with source references.
- Provide a local Web UI for Now, Inbox, Todos, People, Knowledge, Timeline, Loop, and Settings.
- Reserve Loop as a visible but disabled V1 surface and data contract; V1 will not execute external actions.
- Add automated tests for storage, synchronization, domain logic, APIs, and frontend behavior.

## Capabilities

### New Capabilities

- `markdown-context-store`: Versioned Markdown schemas, canonical workspace layout, safe writes, source references, rebuildable indexes, and generated/manual/hybrid ownership rules.
- `lark-context-sync`: Read-only Lark identity, message, calendar, task, and contact synchronization with checkpoints, overlap windows, pagination, deduplication, and error reporting.
- `todo-management`: Todo extraction, candidate review, lifecycle, commitment direction, priority scoring, Leader boosts, and automation eligibility metadata.
- `people-profiles`: Stable cross-source identities, evidence-backed role and collaboration observations, Leader configuration, and computed mutual-commitment views.
- `knowledge-wiki`: Provenance-backed work knowledge, drafts, typed knowledge pages, summaries, search, references, and supersession state.
- `context-workbench-ui`: Local Web UI and API for Now, Inbox, Todos, People, Knowledge, Timeline, Settings, editing, filtering, and sync visibility.
- `automation-loop-readiness`: Disabled V1 Loop navigation, readiness views, Todo automation contract, policy placeholders, and safeguards preventing external execution.

### Modified Capabilities

None.

## Impact

- Adds a TypeScript workspace containing a reusable domain/core package, a Node.js local server and Lark CLI adapter, and a React frontend.
- Adds filesystem content under a configurable workspace root and a generated local search/index cache.
- Depends on the installed `lark-cli` for Lark access and user authentication.
- Introduces local HTTP APIs for browsing, editing, synchronizing, and searching context documents.
- Handles potentially sensitive work data, requiring localhost-only defaults, minimal collection, provenance, and credential exclusion.
