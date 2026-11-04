# Cursor Task queries handoff

工具：本机 Cursor Agent；显式 --model auto。这是实施者报告，不代替父 Agent 验收。

I'll implement only the Read-only Task queries slice: first I'll read the task doc, AGENTS.md, and existing storage/query patterns, then touch only `src/storage/task-queries.ts` and `tests/task-queries.spec.ts`.Next I’ll inspect LocalStore, SQLite layout, and lifecycle ticket shapes so the read-only query API matches existing fixtures.I have the schema and query patterns; implementing `TaskQueries` and its tests next.Implemented read-only **TaskQueries** in the two owned files only.

### Delivered
- `src/storage/task-queries.ts` — `TaskQueries(db)` with `get`, `list`, `counts`
  - Projected rows: `{id,title,status,updatedAt,priority,agentId?,source,rowid}`
  - No schema/init writes; bound SQL params; `ORDER BY rowid DESC` cursor (`beforeRowid`, max limit 200)
  - Filters: lifecycle `states`, latest-assignment `agentId` (`assignments[#-1]`), `lifecycle.issue.source`
  - `counts()` via SQL `GROUP BY` status; unknown/missing lifecycle fails closed
- `tests/task-queries.spec.ts` — LocalStore fixtures, pagination, filters, malformed rows, injection inputs, byte/schema unchanged

### Checks
- `pnpm exec vitest run tests/task-queries.spec.ts` — 9/9 passed
- `pnpm exec tsc --noEmit -p tsconfig.test.json` — passed
- Full `pnpm check` not run

### Integration note for parent
Module is not wired into CLI/barrels (owned files only).
