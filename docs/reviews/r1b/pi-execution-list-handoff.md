# pi execution queries handoff

Implemented in:

- `src/application/product-queries.ts`
- `tests/product-queries.spec.ts`

Added owner/workspace-scoped `executions()` with parameterized filters, descending rowid pagination, bounded limits, strict option validation, unique valid states, and actual execution-column identity validation. Fixed the reported existing `parseExecution` identity-check gap.

Tests passed:

- `node_modules/.bin/vitest run tests/product-queries.spec.ts` — 10/10
- Source and test TypeScript typechecks
- `git diff --check`

Limitations: cursor stability follows SQLite `rowid`; visibility intentionally excludes orphaned, non-manual, cross-workspace, cross-owner, or source-actor-mismatched execution rows. Full repository suite was not run.
