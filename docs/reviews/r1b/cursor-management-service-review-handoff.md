# Cursor Auto handoff

Implementation report only; accepted state is in MANAGEMENT_ACCEPTANCE.md.

I'll review the completed SERVICE work and harden receipt replay plus static unknown-field errors, keeping your owned files untouched.Next I'll inspect receipt parsing and how repository snapshots bind identity, using task-commands as the reference pattern.Implementing hardened snapshot-bound receipt replay and static unknown-field messages in the SERVICE-owned files.The file may already have partial edits — checking its current state.Partial edits are present; fixing call sites and completing the receipt-replay hardening.Adding corruption, replay-after-edit, and secret-shaped property tests.Fixing the receipt-count assertion so it accounts for each inserted corrupt receipt.Fixing the TypeScript narrowing on `stored.version`.SERVICE receipt replay and unknown-field hardening are done; owned files only.

### Changes
**`src/application/management-commands.ts`**
- `parseStoredResult` binds result `kind`/`id` to the normalized command (`input.id` or `command.id`)
- Loads the immutable version via `EmployeeRepository.snapshot` / `ProjectRepository.snapshot`
- Requires exact equality with the stored receipt resource (exact keys + values, including arrays)
- Returns the **snapshot**, so replay after later edits still yields the original version
- No Git path / active binding checks on replay
- `unknownFieldMessage` is fully static (`Unknown ${label} field`) — never echoes keys

**`tests/management-commands.spec.ts`**
- Replay after later edits returns original snapshot
- Corrupt / foreign / wrong-kind / wrong-id / malformed-array / in-place replaced body → `Corrupt management receipt`, no writes, no leakage
- Secret-shaped property test: 32× 64-hex field names + credential-shaped key never echoed

Left untouched: `projects` prepare/commit, storage schema, `web/src/api.ts`, no installs/commits.

### Tests
`pnpm exec vitest run tests/management-commands.spec.ts tests/projects.spec.ts` → **26 passed**
`tsc --noEmit` (main + test) → clean

### Parent hookup still needed
`initializeApplicationSchema` still does **not** install management schema (existing dependency check).
