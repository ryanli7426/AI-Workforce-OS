# Cursor Auto handoff

Implementation report only; accepted state is in MANAGEMENT_ACCEPTANCE.md.

I'll read the repo contract and the R1 management commands task doc first, then implement only the SERVICE ownership section with tests.Next I'll inspect existing application/storage patterns and any stubbed management-command files so the SERVICE slice matches the repo.I have enough of the patterns — implementing storage schema, `prepareCreate`, the management service, and tests next.Implementing the storage schema and project `prepareCreate` extraction.Writing the application service next.Writing the management-commands tests and updating projects specs.SQLite rejected `rowid` in the index definition — removing it.SERVICE ownership is implemented and covered by tests.

### Files
- `src/storage/management-commands.ts` — schema `management-schema` v1, receipts + audits, explicit init/require
- `src/application/management-commands.ts` — `LocalManagementCommands`, command types/errors, replay + audit
- `src/projects/projects.ts` — `prepareCreate` / `commitCreate` (opaque same-instance token); `create()` unchanged for callers
- `tests/management-commands.spec.ts` — new
- `tests/projects.spec.ts` — prepare/commit/forge/in-tx cases

### Behavior
- Atomic resource + snapshot + audit + receipt; idempotent key replay; hash collision → `IDEMPOTENCY_CONFLICT`
- Project-create: replay check → Git/path preflight **outside** tx (`db.isTransaction === false`) → recheck + `commitCreate` inside tx
- Employee create always disabled; allowlist `runtimeIds`; same-workspace non-archived project bindings; enabled sensitive updates rejected
- Constructor does **not** migrate; fail-closed on missing/unsupported/corrupt schema

### Tests
`vitest run tests/management-commands.spec.ts tests/projects.spec.ts` → **23 passed**
`tsc -p tsconfig.json` / `tsconfig.test.json` → clean for owned code

### Parent dependencies (not edited)
1. Wire `initializeManagementSchema(store.db)` into `initializeApplicationSchema` (and MODULE_KEYS / version gate)
2. HTTP/API: construct `LocalManagementCommands` with `runtimeIds: ['claude-local']` after schema init
3. Web `ApiClient.manage` / `managementHistory` + mocks still pending (types resolve from this service)
