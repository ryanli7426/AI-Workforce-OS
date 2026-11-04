# Cursor Auto execution-logs

Implementation report only. Parent corrections and integrated gates determine acceptance.

I'll start by reading the task section and AGENTS.md, then inspect the two owned files before implementing.Next I'll inspect the two owned files and related storage/runner patterns so the implementation matches the repo.I have enough contract detail to implement the two owned files: read-only SQLite scoping plus bounded tail reads of runner logs.Cleaning unused imports/exports, then writing the tests.Fixing the test fixture: it needs a real git repo, and I'll clean up the broken helpers.Fixing ENOENT handling on missing DB paths and giving the second reserved execution a distinct cwd.Implemented query-only `readExecutionLogs` in the two owned files.

### Delivered
- `src/observability/execution-logs.ts` — async `readExecutionLogs({dataDir, ticketId, executionId?, maxBytes?})`
- `tests/execution-logs.spec.ts` — 11 tests against real initialized SQLite/Task fixtures

### Behavior (fail-closed)
- Snapshots inputs before await (mutation-safe)
- Default `maxBytes` 64KiB, bound 1..1MiB
- Private dataDir / settings / DB checks; Darwin `/var`,`/tmp` alias only
- SQLite `readOnly` + main schema `12` + module version validation via `applicationRepositories` (no LocalStore/migrate/init)
- Scopes by settings `ownerId`/`workspaceId` + ticket mandate/source + project workspace
- Rejects unknown/foreign ticket and foreign/unknown execution selection
- Reads only `runners/<executionId>/{stdout,stderr}.log`; never `request.json`/tokens
- FD tail reads (not read-all-then-slice), UTF-8 lead-byte skip, `StreamingRedactor`
- Missing logs for reserved executions → empty streams, no creation
- Returns persisted DB `state` only (no live process health claims)

### Gates
- `pnpm typecheck` — pass
- `pnpm exec vitest run tests/execution-logs.spec.ts` — **11/11 pass**

### Limitations / parent integration
- Not wired into CLI (`Parent later wires CLI logs`)
- No `pnpm check` full suite / build / smoke / commit / push
- Does not claim daemon/Runtime/DingTalk operational
