# Cursor Auto handoff

Implementation report only; accepted state is in MANAGEMENT_ACCEPTANCE.md.

I'll read the repo contract and the R1 management-commands task doc first, then implement only the HTTP ownership section with tests.Next I'll inspect existing API route patterns and the management command contracts so the HTTP ownership slice matches them.There's a sibling service worktree — I'll inspect its contract exports so routes can match without inventing the service.I'll implement routes against the shared contract and a test Fastify factory that reuses real auth; then I'll wire tests once the service sibling lands.Writing the routes module against the documented contract, mirroring the existing task-route patterns.Simplifying command typing and checking whether the service sibling has landed.Service sibling files are in — I'll read their exports and stage reviewed copies for local verification only.Next I'll write the management-routes tests, patterned on the existing API server suite.Fixing TypeScript errors in the routes module and the staged storage cast.Auth failures were mapped to 500 by the plugin error handler — I'll forward `ApiAuthError` the same way the main server does.Switching off the encapsulated error handler so parent auth mapping stays intact; handlers will catch management errors directly.HTTP ownership is done. `registerManagementRoutes` is implemented with full route coverage and 11 passing tests.

### Owned files
- `src/api/management-routes.ts` — `registerManagementRoutes(app, {store, settings})`
- `tests/management-routes.spec.ts` — composed against `createApiServer` + real SQLite/auth

### Behavior
- Routes: employee/project create·update·enable/archive + history
- Create → 201; others → 200; `Idempotency-Key` required; `Idempotency-Replayed` set
- Schema preflight via `requireManagementSchema` (no migrate/listen/Runtime)
- `runtimeIds: [settings.runtime.id]` (`claude-local`); no actor/workspace injection
- Typed management errors mapped in-handler; parent auth/Host/Origin untouched

### Tests
`vitest run tests/management-routes.spec.ts` → **11/11 passed**
Also green: `tests/projects.spec.ts`, `tests/api-server.spec.ts` (36 total with those)

### Dependencies (parent)
Staged reviewed copies from service sibling for local verification only (not HTTP-owned; parent must copy/review):
- `src/application/management-commands.ts`
- `src/storage/management-commands.ts`
- `src/projects/projects.ts` (`prepareCreate` / `commitCreate`)

Parent still needs: register routes after global hooks, explicit `initializeManagementSchema` in initializer, final service integration review. No installs/commits/pushes.
