## Context

The repository currently contains only OpenSpec configuration. The product is a single-user, local-first work context system whose canonical data lives in human-readable Markdown. V1 reads relevant Lark data through the locally installed `lark-cli`, synthesizes Todo, people, knowledge, and summary views, and serves a localhost Web UI. The design must preserve source provenance, protect manual edits, avoid credential storage, and leave an explicit but non-executing boundary for a future automation Loop.

The main stakeholders are the workspace owner, who needs a trustworthy daily work surface, and future adapter or automation authors, who need stable source-neutral contracts.

## Goals / Non-Goals

**Goals:**

- Deliver a runnable TypeScript application with a local API server and React frontend.
- Keep Markdown as the only canonical business data and make all indexes disposable.
- Provide safe workspace initialization, typed document parsing, atomic writes, search, and backlinks.
- Read group mentions, P2P messages, calendar events, tasks, and people from `lark-cli --as user`.
- Produce explainable Todo priorities, people views, knowledge pages, and a Now summary.
- Expose source references and generated/manual/hybrid ownership in both APIs and UI.
- Make Loop visible in navigation and document contracts without providing any execution path.
- Cover core logic, storage, synchronization, API behavior, and frontend rendering with automated tests.

**Non-Goals:**

- Executing tools or mutating Lark resources.
- Hosted multi-user deployment, remote authentication, or collaborative editing.
- A mandatory remote LLM provider in V1.
- Full archive of every group message or binary attachment analysis.
- A durable database that can diverge from Markdown.

## Decisions

### Use a modular TypeScript application

The repository will use one npm project with clear `core`, `server`, `adapters`, and `web` modules. A Node server provides filesystem and `lark-cli` access; a React/Vite client provides the workbench. This keeps a single language across contracts and UI while retaining boundaries that can later become packages.

Alternatives considered:

- A static-only site cannot safely access local Markdown or invoke `lark-cli`.
- A database-first framework conflicts with the Markdown canonical-source requirement.
- Separate services add operational cost without benefit for a single-user V1.

### Make Markdown canonical and indexes rebuildable

The workspace root defaults to `./workspace` and can be overridden with `CONTEXT_SPACE_ROOT`. Every document has YAML frontmatter with a versioned schema, stable ID, type, management mode, timestamps, and source references. Writes use a temporary sibling file followed by atomic rename. Paths are resolved below the workspace root and traversal is rejected.

Search and backlink data are built in memory from Markdown on startup or explicit rebuild. This is simpler than SQLite for V1 while preserving the contract that a future SQLite index is only a cache.

### Separate source documents from derived documents

Adapters write normalized source documents under `sources/<provider>/`. Domain analyzers read those documents and create candidates or derived documents under `inbox`, `todos`, `people`, `knowledge`, and `summaries`. Source documents are generated, derived documents are generated or hybrid, and user-owned configuration is manual.

Every derived document stores stable `source_refs`; the system never relies on a generated summary as the sole evidence for another conclusion.

### Define a source-neutral adapter contract

Adapters return normalized records with `sourceId`, `kind`, timestamps, participants, text, and provider metadata. Lark-specific fields remain in provider metadata. Stable IDs use provider namespaces, such as `lark:message:om_xxx`.

The Lark adapter invokes `lark-cli` with `execFile` and an argument array, never a shell string. V1 exposes only read operations:

- `contact +get-user`
- `im +messages-search --is-at-me`
- `im +messages-search --chat-type p2p`
- `calendar +agenda`
- `task +get-my-tasks`

Initial backfill is split into bounded time windows. Incremental runs use a checkpoint, an overlap window, and stable-ID deduplication. Partial failures are reported per source and do not corrupt the previous checkpoint.

### Use deterministic V1 analysis behind replaceable interfaces

V1 ships deterministic extractors for explicit action language, due dates already present in source metadata, people discovery, and knowledge candidates. Analyzer interfaces accept structured source records so a future local or remote LLM can replace or augment heuristics without changing storage or UI contracts.

Native Lark tasks become authoritative Todo items. Explicit but non-native actions become candidates unless confidence crosses a configured threshold. Knowledge extraction creates drafts by default.

### Keep priority scoring explainable

Priority is represented by a base score, named boosts, an effective score, and an optional manual override. Due urgency, explicit assignment, staleness, and Leader involvement are independent named reasons. Leader configuration is manual and applies to `owed_by_me` execution or follow-up visibility, not to work that a Leader owes the user.

### Compute relationship views instead of duplicating facts

People profiles contain identities, facts, observations, and evidence. Mutual commitments are projections over Todo stakeholder references, so profile pages never store a second editable copy of Todo state. Cross-provider identity merging is manual in V1.

### Serve a localhost API and route-based workbench

The server binds to `127.0.0.1` by default. JSON APIs expose overview, documents, search, configuration, and Lark sync status. The React app has stable top-level routes for Now, Inbox, Todos, People, Knowledge, Timeline, Loop, and Settings.

The UI distinguishes generated content from manual or hybrid content and displays provenance and priority reasons.

### Make Loop an intentionally inert boundary

Todo documents include:

```yaml
automation:
  mode: disabled
  handler: null
  requires_confirmation: true
  allowed_capabilities: []
```

V1 has a Loop page and readiness cards but no execute endpoint, scheduler, tool registry, or enabled action control. Future execution will require `status: open`, `automation.mode: approved`, policy authorization, confirmation rules, and auditable runs.

### Test at domain, integration, API, and UI layers

Vitest covers pure domain logic and temporary-directory storage integration. Adapter tests use an injected command runner and never call a real Lark account. API tests run the local server against a temporary workspace. React Testing Library verifies navigation, Now, Todo priority explanations, and the disabled Loop surface.

## Risks / Trade-offs

- **[Markdown concurrency can lose edits]** → Use atomic writes, compare `updated_at`/ETag values, and reject stale updates.
- **[Message search pagination can truncate backfill]** → Split time ranges, request all pages, record checkpoints, and surface incomplete runs.
- **[Heuristic extraction can create false positives]** → Route uncertain actions and all knowledge extraction to Inbox drafts with evidence.
- **[People observations can become invasive or wrong]** → Restrict to work behavior, attach confidence/evidence, and preserve user corrections.
- **[Large workspaces can slow full scans]** → Keep the index replaceable, cache file metadata, and allow targeted rebuilds later.
- **[Remote model use could expose sensitive data]** → Ship without a required remote model and make any future provider explicit and configurable.
- **[Visible Loop UI could imply execution exists]** → Label it as disabled, remove action endpoints and controls, and test that no execution route exists.
- **[Local server could be exposed accidentally]** → Bind to loopback by default and require explicit configuration for any other host.

## Migration Plan

1. Install dependencies and initialize the workspace layout on first run.
2. Start with an empty source tree and generated empty-state summaries.
3. Validate `lark-cli` availability and user authorization without changing Lark data.
4. Run an optional bounded initial backfill, then persist the first checkpoint.
5. Rebuild the index and expose the local workbench.

Rollback consists of stopping the server and restoring or deleting the generated workspace. Canonical Markdown can be backed up independently; indexes can always be removed and rebuilt.

## Open Questions

- Which optional LLM provider, if any, should be enabled after the deterministic V1?
- What retention window should apply to raw P2P transcripts and mention context after initial use?
- Should future cross-source identity merges be manual-only or use reviewable suggestions?
