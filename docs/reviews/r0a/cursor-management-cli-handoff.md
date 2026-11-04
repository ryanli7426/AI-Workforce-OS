# Cursor Auto management-cli implementation handoff

Implementation report only. Parent review, corrections and integrated gate results are tracked separately.

I'll read AGENTS.md and the Management CLI section of the mainline tasks, then implement only those owned files.Next I’ll inspect the existing CLI, related APIs, and current tests so the Management CLI extension matches the baseline contracts.I have enough API context; implementing the Management CLI extension and its tests next.Tightening command typing so TypeScript narrows correctly, then adding the management tests.Fixing typecheck errors and the project path assertion from macOS `/var` vs `/private/var`.Management CLI extension is in the two owned files only.

### Owned changes
- `src/cli/index.ts` — `init` now calls `initializeApplicationSchema(LocalStore)`; added `employees`, `employee-create`, `employee-enable`, `projects`, `project-create`, `backup`; help updated; workspace fixed to `local`
- `tests/cli-management.spec.ts` — 27 new tests (happy paths, no-init, readonly bytes, workspace/unknown fields, symlink/size/JSON rejects, arg validation, legacy/module schema rejection, doctor non-mutating)

### Actual checks run
| Gate | Result |
|------|--------|
| `tsc --noEmit -p tsconfig.json` + `tsconfig.test.json` | pass |
| `vitest run tests/cli.spec.ts tests/cli-management.spec.ts` | **44/44** pass (17 foundation + 27 management) |
| `vitest run tests/cli-management.spec.ts` | **27/27** pass |
| `pnpm build` | pass |
| Full `pnpm check` / full 387+ suite | **not run** (scoped to owned surface) |

### Unresolved integration (parent)
- Docs / delivery tracker / smoke CLI coverage for new commands
- Compiled smoke (`scripts/smoke.mjs`) may still only exercise foundation commands
- Re-`init` upgrades main-schema-only DBs by installing module schemas; parent should decide messaging
- No commit/push (per instructions)
