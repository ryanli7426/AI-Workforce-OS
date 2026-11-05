# Cursor Auto handoff

Implementation report only; accepted state is in MANAGEMENT_ACCEPTANCE.md.

I'll read the contract docs first, then implement only the WEB ownership section with tests.Exploring existing web pages, API client contracts, and shared UI patterns next.Inspecting confirmation/mutation patterns in tasks and whether management types are stubbed elsewhere.Implementing `EmployeesManager` and `ProjectsManager` to mirror the tasks confirmation/idempotency patterns. Types come from the browser API module; missing `management-commands.ts` is a reported dependency.Writing `management.tsx` and its behavior tests.Cleaning unused exports/imports, then writing the tests.Cleaning unused exports/imports, then writing the behavior tests.Creating a minimal type-only module so parent API imports resolve for tests—checking whether that's already present, then running the owned specs.Fieldset `disabled` isn't reflected on checkbox `.disabled` in jsdom — setting it on the inputs directly.All tests passed. Adding `StatusBadge` usage to match the shared UI contract, then verifying typecheck dependency.WEB ownership is done. Parent review needed before integration.

### Files changed (owned only)
- `web/src/pages/management.tsx` — exports `EmployeesManager`, `ProjectsManager`
- `web/src/pages/management.spec.tsx` — 7 behavior tests

No sibling/shared-contract edits, installs, commits, or pushes.

### Behavior covered
- Employee create always as disabled config; separate enable confirmation
- Enabled employee: sensitive fields locked; update DTO is name/role + `expectedVersion` only
- Reason + confirmation preview; stable idempotency key on ambiguous failure; 409 clears preview and forces reconfirm from refreshed version
- Project path immutability; archive warning (blocks future intake, not running tasks)
- Real `managementHistory` for selected resource; invalidates `employees` / `projects` / `overview` / `tasks` / history on success
- Runtime picker: `claude-local` only (configured, not online)

### Tests
```text
node_modules/.bin/vitest run --config web/vitest.config.ts web/src/pages/management.spec.tsx
→ 7 passed
```

### Dependencies (parent / siblings)
1. **`src/application/management-commands.ts`** — missing; `web/src/api.ts` already imports its types (`ManagementCommand` / `ManagementResult` / `ManagementAudit`). Service sibling still pending.
2. **Parent `createApiClient`** — interface has `manage` / `managementHistory`, but implementation not wired yet.
3. **Sibling test mocks** — `overview.spec.tsx` / `tasks.spec.tsx` need `manage` / `managementHistory` (parent noted).
4. **Routing** — parent still switches `#/employees` / `#/projects` to these managers; old read-only pages stay for compatibility.

`web:typecheck` still fails on those parent/service gaps; owned specs pass in isolation.
