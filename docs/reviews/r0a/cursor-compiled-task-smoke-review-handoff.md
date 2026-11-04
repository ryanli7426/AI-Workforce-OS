# Cursor Auto compiled-task-smoke-review handoff

Implementation report only; parent review and integrated gates determine acceptance.

I'll own only `tests/compiled-task-cli.spec.ts` and align it with the contract: real `--checks-file` happy path, no dep skips, safe process cleanup, and a longer wait-success detach proof.Rewriting the smoke spec to match the five contract corrections, then checking whether parent modules have landed.Simplifying cleanup to track data dirs and use Runner stop tokens instead of the fragile `find` path.Dependencies arrived. Rebuilding and running the smoke suite.First CLI return can leave the execution in `STARTING`; I'll poll once until `RUNNING` after that return.Corrected `tests/compiled-task-cli.spec.ts` only. Parent deps (`task-commands`, `local-orchestrator`, async `runTaskCommand` routing) were already present; no dependency edits, installs, commits, or model calls.

### Fixes
1. Happy path uses `--checks-file` with absolute `process.execPath` + `-e` asserting README typo fixed and `SMOKE_MARKER.txt` untouched; expect `state: 'passed'`.
2. Separate governance test for exclusive `--waive` / `--checks-file` (happy path no longer waives).
3. Removed `DEPS_READY` / source-grep gates; build + behavior gate the suite.
4. Cleanup uses Runner stop token + await on owned execution IDs; emergency kill only after live `/proc` or `ps` identity match — never signals historical PIDs from completed records.
5. Detach proof: `wait-success` at 1600ms; first `run-once` returns, then bounded poll confirms `RUNNING` once.

### Actual results
| Gate | Result |
|------|--------|
| `pnpm build` | pass |
| `vitest run tests/compiled-task-cli.spec.ts` | **6 passed** |
