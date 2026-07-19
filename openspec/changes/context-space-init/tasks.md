## 1. Project Foundation

- [x] 1.1 Add the TypeScript, React, Vite, server, test, and lint project configuration with runnable npm scripts
- [x] 1.2 Add Git ignore rules and document local development, workspace, synchronization, testing, and privacy behavior
- [x] 1.3 Implement idempotent workspace initialization with baseline config, summary, Loop policy, and run-history locations

## 2. Markdown Store and Index

- [x] 2.1 Define versioned document, source, Todo, person, knowledge, sync, and automation TypeScript contracts
- [x] 2.2 Implement safe Markdown parsing, path containment, atomic writes, and optimistic concurrency
- [x] 2.3 Implement a rebuildable in-memory search and backlink index over canonical Markdown

## 3. Domain Analysis

- [x] 3.1 Implement Todo defaults, lifecycle projections, explainable priority scoring, manual overrides, and Leader boosts
- [x] 3.2 Implement stable people discovery, Leader configuration, evidence filtering, and mutual-commitment projections
- [x] 3.3 Implement deterministic Todo and knowledge candidate extraction with provenance and confidence
- [x] 3.4 Implement Now, Inbox, timeline, knowledge-change, and Loop-readiness aggregation

## 4. Lark Adapter

- [x] 4.1 Implement an injected `lark-cli` command runner with a strict read-only allowlist and user identity
- [x] 4.2 Implement bounded mention, P2P, calendar, task, and self/contact retrieval and normalization
- [x] 4.3 Implement checkpoint overlap, stable-ID deduplication, partial-failure isolation, source persistence, and sync status

## 5. Local API

- [x] 5.1 Implement a loopback-only server with health, overview, document, search, configuration, and timeline APIs
- [x] 5.2 Implement optimistic document updates, Leader configuration, index rebuild, and manual Lark synchronization APIs
- [x] 5.3 Ensure no V1 automation execution endpoint or external-action code path exists

## 6. Web Workbench

- [x] 6.1 Implement the responsive application shell, visual system, global search, and eight primary routes
- [x] 6.2 Implement Now, Inbox, and Todos pages with priority explanations, filters, evidence, and empty states
- [x] 6.3 Implement People, Knowledge, and Timeline pages with provenance and relationship views
- [x] 6.4 Implement Loop and Settings pages with readiness categories, disabled automation messaging, sync status, and Leader controls

## 7. Verification

- [x] 7.1 Add unit and integration tests for workspace storage, path safety, concurrency, index rebuild, priority, people, and extraction
- [x] 7.2 Add adapter and API tests for read-only commands, idempotent sync, partial failures, routes, and absence of an execution endpoint
- [x] 7.3 Add frontend tests for navigation, Now content, Todo filtering, provenance, and the disabled Loop surface
- [x] 7.4 Run type checking, linting, all tests, and production builds; resolve failures and record the verified commands
