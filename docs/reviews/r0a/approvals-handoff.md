# Cursor Scoped approvals handoff

工具：本机 Cursor Agent；显式 --model auto。这是实施者报告，不代替父 Agent 验收。

I'll implement only Scoped approvals in the owned files. Reading the task doc, AGENTS.md, and existing approval patterns first.Looking at sibling repository patterns and existing governance/storage structure.Sibling intents package should mirror the same schema/repo pattern — checking that implementation.I have enough of the contract and storage patterns to implement the approvals module and its tests.Tightening the API to the task exports and fixing the concurrency test so it won't hit SQLITE_BUSY.I botched the decide-test edit — reading the file and correcting it.Scoped approvals are in place in the two owned files only.

### Files
- `src/governance/approvals.ts` — `initializeApprovalSchema(db)`, `ApprovalRepository(db)` with `create` / `get` / `decide` / `consume`
- `tests/approvals.spec.ts`

### Behavior
- KV `approval-schema` = 1; future versions rejected before DDL/writes; savepoints on init and mutations
- Immutable PENDING requests; decide requires `authorized === true`, nonempty reason, no self-approval, expiry check; identical decisions idempotent, conflicts rejected
- Consume once via `UPDATE … WHERE consumed_at IS NULL` with exact scope match; stale policy/params/artifact/execution fail without consuming
- Append-only `approval_audit` for request / decision / consumption; defensive clones on return

### Checks run
- `pnpm exec vitest run tests/approvals.spec.ts` — 10/10 passed
- `pnpm exec tsc --noEmit -p tsconfig.test.json` — passed
- Full `pnpm check` — not run

### Missing integration (parent)
Not wired into `LocalStore`, `src/index.ts`, CLI, or app auth. This repo trusts caller-supplied `authorized`; it does not authenticate or grant Agent authority.
