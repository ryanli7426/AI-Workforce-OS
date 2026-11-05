# Cursor CLI implementation

Implementation handoff; parent gates remain authoritative.

I'll read the task doc and existing CLI patterns first, then implement only the verification command files you named.The task doc covers engine/transport; next I'll locate the CLI ownership section and mirror existing command patterns.I have enough of the CLI and verification contracts to implement the two owned files.Cleaning up a broken helper and checking whether `LocalStore` exposes a path property.Removing the broken helpers and keeping `withLocalStore` as the only store path.Updating status to a readonly DB path so queries don't mutate storage, then adding tests.WAL sidecars from readonly opens are skewing the file-list assertions — I'll tighten those checks and inspect the remaining failure.Tests and typecheck passed. Reviewing the implementation for leftover issues.Durable verification CLI is in the two owned files only (`src/cli/verification-commands.ts`, `tests/verification-cli.spec.ts`). `index.ts` was not touched.

**Commands:** `verification-plans-init`, `verification-plans`, `verification-create`, `verification-status`, `verification-cancel` via `runVerificationCommand` (returns `undefined` for unknown commands).

**Plans file format (documented choice):** exact `{ "plans": [VerificationJobPlan, ...] }` — not a bare array. Private 0600 nofollow read through `verification/protocol`; exclusive `createVerificationPlans` (no overwrite). Listing prints only `id` / `revision` / `checkIds` / `timeouts`.

**Guards:** strict unknown/duplicate args; id/key/version/artifact validation; private 0700 data dir + owned SQLite/no symlinks; readonly main+module+verification schema preflight before `LocalStore`; queries (`plans`/`status`) avoid domain file creation; static/redacted errors (no raw argv/secrets).

**Verify:** `pnpm exec vitest run tests/verification-cli.spec.ts` — 10 passed; `pnpm typecheck` — passed.

**Parent integration:** route `runVerificationCommand(argv, io) ?? …` before other dispatchers and extend help text.
