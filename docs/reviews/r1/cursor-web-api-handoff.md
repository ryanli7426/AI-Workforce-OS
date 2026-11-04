# Cursor Auto implementation report

Report is implementation evidence; parent acceptance is recorded separately.

I'll read the task slice and repo contract first, then implement only the API1 ownership section with tests.Next I'll inspect the existing API client contract and backend shapes so the API1 client matches them.Implementing the API client and its full test suite now.Fixing sync validation (so tests get rejections) and hardening the abort/timeout coverage.Fixing the type assertion errors in our owned file.API1 ownership is done. Only `web/src/api.ts` and `web/src/api.spec.ts` were changed.

### Changed files
- `web/src/api.ts` — `ApiError`, `createApiClient(token)`, `newCommandKey()`; preserved `ApiClient` + type re-exports
- `web/src/api.spec.ts` — new owned suite

### Client behavior shipped
- Token closed over; no public token; fixed relative `/api/v1`
- `fetch`: `redirect:'error'`, `credentials:'omit'`, `cache:'no-store'`, Bearer + Accept JSON, JSON body only on POST
- 15s timeout via `AbortSignal.timeout` + `AbortSignal.any` with caller signal
- Safe ID/key checks before URL; task/log query fields limited to contract
- One POST per call (no auto-retry); static Chinese errors by allowlisted code; top-level response shape checks; 4MiB response cap

### Test evidence
```text
./node_modules/.bin/vitest run --config web/vitest.config.ts web/src/api.spec.ts
Test Files  1 passed (1)
Tests  21 passed (21)
Duration  408ms
```
(`pnpm exec vitest …` aborted here: pnpm tried `pnpm install` / no TTY; ran local vitest binary instead — no install.)

Owned `web/src/api.ts` has no tsc errors under `web/tsconfig.json`. Pre-existing `src/core/model.ts` `findLast` / lib errors remain outside ownership.

### Dependencies / gaps for parent
- UI1/UI2 page files absent (other owners); not invented
- Real API TCP acceptance not run (parent)
- No installs / commits / pushes / nested agents / real model calls
