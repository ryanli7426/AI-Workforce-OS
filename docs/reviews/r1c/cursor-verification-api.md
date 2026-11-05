# Cursor HTTP implementation

Implementation handoff; parent gates remain authoritative.

I'll read the task brief and AGENTS.md, then inspect existing management-routes patterns and the files I own.The task doc covers engine/transport; I'll dig into API ownership details and the management-routes pattern next.I'll inspect how management tests wire Fastify auth and how tasks reach REVIEW so the verification routes can follow the same pattern.I have enough of the contracts—implementing the routes module and the test suite next.Fixing the dataDir absolute-path check to use a normal `node:path` import.All ten tests passed. Running typecheck next.Verification HTTP routes are ready for parent integration.

**Owned files**
- `src/api/verification-routes.ts` — `registerVerificationRoutes(app, {store, settings, dataDir})`
- `tests/verification-api.spec.ts` — Fastify `onRequest` auth wrapper (no `server.ts` edits)

**Behavior**
- Construction: `requireVerificationSchema` (no migrate) + immutable `loadVerificationPlans` + scoped `LocalVerificationCommands`
- `GET /api/v1/verification-plans` → metadata only (`id`/`revision`/`checks[{id,timeoutMs}]`)
- `POST /api/v1/tasks/:id/verifications` → `202` `{verificationId,replayed}` + `Idempotency-Replayed`
- `GET /api/v1/tasks/:id/verifications` → bounded `limit`/`beforeRowid` (string positive ints, no coercion)
- `GET /api/v1/verifications/:id` → `{job,history}` with redacted plan commands
- `POST /api/v1/verifications/:id/cancel` → `202` same result DTO
- Errors: 400/404/409 mapped; operational errors propagate to generic 500
- No Runtime/worker/controller startup; enqueue stays `QUEUED`

**Verification**
- `pnpm exec vitest run tests/verification-api.spec.ts` — 10 passed
- `pnpm typecheck` — passed

**Parent hookup:** after auth hooks in `createApiServer`, call `registerVerificationRoutes(app, {store, settings, dataDir})`.
