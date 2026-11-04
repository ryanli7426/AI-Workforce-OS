# Cursor Auto implementation report

Report is implementation evidence; parent acceptance is recorded separately.

I'll fix only `tasks.tsx` and its spec: start by reading those files and the API types they should use.I have enough context to implement the five review fixes in `tasks.tsx` and its spec.Fixed only `web/src/pages/tasks.tsx` and `web/src/pages/tasks.spec.tsx`.

### Changes
1. **Hash filters** — Parse `#/tasks?projectId=&employeeId=&state=` on mount (safe IDs / known states only). Employee filter uses `api.employees()`, included in list options; cursor resets on filter change.
2. **BLOCKED + UNKNOWN** — Retry hidden when any non-terminal execution (`STARTING`/`RUNNING`/`STOPPING`/`UNKNOWN`) still holds a reservation; server remains authoritative.
3. **Action pending** — Begin/fields/preview/submit/back disabled or no-op while mutating; 409 clears draft + reason so a fresh confirmation is required.
4. **Copy** — Preview shows 操作/任务/版本/原因/执行/产物修订; removed forge / one-click / raw `expectedVersion` chatter; keep meaningful cancel/verify constraints.
5. **Idempotency** — Create + action reuse the same key after uncertain network failure.

### Tests
```text
pnpm exec vitest run --config web/vitest.config.ts web/src/pages/tasks.spec.tsx
Test Files  1 passed (1)
Tests       10 passed (10)
```
