## Verification Report: separate-machine-and-human-context-storage

### Summary

| Dimension | Status |
|---|---|
| Completeness | 42/42 tasks；40/40 requirements |
| Correctness | 40/40 requirements and 54/54 scenarios covered by implementation or regression evidence |
| Coherence | Storage ownership, transaction boundaries, recovery state machines and local-only security follow the design |

### Evidence Map

| Capability | Primary implementation | Primary verification |
|---|---|---|
| Machine context store | `src/machine/database.ts`, `migrations.ts`, `context-repository.ts`, `settings-repository.ts`, `retention-worker.ts` | `machine-database.test.ts`, `machine-context.test.ts` |
| Durable analysis queue | `src/machine/analysis-repository.ts`, `src/analysis/persistent-processor.ts`, `worker.ts` | `analysis-queue.test.ts`, `analysis-worker.test.ts` |
| Lark sync | `src/adapters/lark/sync.ts` | `lark.test.ts`, `api.test.ts` |
| Candidate review | `src/analysis/candidate-review.ts` | `candidate-review.test.ts`, `api.test.ts`, `frontend.test.tsx` |
| Markdown schemas and index | `src/core/markdown-schema.ts`, `markdown-index-sync.ts`, `src/machine/markdown-index-repository.ts` | `markdown-index-sync.test.ts`, `core.test.ts` |
| Composite query and UI | `src/server/context-query.ts`, `app.ts`, `src/web/App.tsx` | `api.test.ts`, `frontend.test.tsx` |
| Local API protection | `src/server/app.ts`, `src/web/api.ts`, `src/server/main.ts` | `api.test.ts`, `frontend.test.tsx` |
| Legacy migration | `src/machine/legacy-migration.ts` | `legacy-migration.test.ts` |

### Issues

#### CRITICAL

None.

#### WARNING

None.

#### SUGGESTION

None required for this change.

### Compatibility Boundaries

- Human Markdown compatibility is intentionally limited to the repository's existing `todo@1`, `person@1` and `knowledge@1` schemas. Unknown versions are diagnosed without rewriting bytes.
- Legacy unfinished analysis runs are imported as terminal failures because their external Provider execution cannot be resumed safely.
- Legacy candidate evidence is imported only when its referenced source exists; stable source references remain available for audit.
- Existing person observations remain user-maintained Markdown and are not reverse-converted into candidates.
- Legacy backup is blocked until the migration report has no failures or conflicts and the user explicitly confirms the move.

### Quality Gate

`npm run check` passed: TypeScript, ESLint, 123 tests, server bundle and production Web build. The OpenSpec change also passed strict validation.

### Final Assessment

All checks passed. Ready for archive.
