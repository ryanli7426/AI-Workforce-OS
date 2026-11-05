# Claude coordinator review

Implemented [tests/verification-coordinator.spec.ts](/private/tmp/workforce-claude-verification-coordinator-20261105/tests/verification-coordinator.spec.ts) only. No production files changed.

Coverage includes:

- Real initialized `LocalStore`, `LocalTaskService`, temporary Git project, and Core `REVIEW` tasks
- Runner I/O outside database transactions
- Enqueue/start exactly once and observe-only restart reconciliation
- Concurrency retention for `UNKNOWN`
- Late first-event recovery
- Repeated ticks and contiguous terminal evidence
- Atomic Task verification, provenance audit, and job application
- Superseded Tasks remaining unchanged
- No automatic Task `DONE`
- Nonzero checks versus infrastructure failure
- Authenticated cancellation stop without early slot release
- Missing reports, digest mismatch, and identity mismatch
- Rollback of terminal job evidence and Task verification together

Validation:

- `pnpm typecheck`: passed
- `pnpm exec vitest run tests/verification-coordinator.spec.ts`: 13 passed, 1 failed

Concrete production defect:

- [verification-coordinator.ts:111](/private/tmp/workforce-claude-verification-coordinator-20261105/src/application/verification-coordinator.ts:111) discards the `RunnerSnapshot` returned by `runner.start()`. Identity validation is performed only for later events and status snapshots at [verification-coordinator.ts:137](/private/tmp/workforce-claude-verification-coordinator-20261105/src/application/verification-coordinator.ts:137) and [verification-coordinator.ts:154](/private/tmp/workforce-claude-verification-coordinator-20261105/src/application/verification-coordinator.ts:154).
- The regression at [verification-coordinator.spec.ts:401](/private/tmp/workforce-claude-verification-coordinator-20261105/tests/verification-coordinator.spec.ts:401) returns a start snapshot bound to a different ticket. Expected behavior is `UNKNOWN/START_UNCONFIRMED` with no further runner reads; actual behavior leaves the job `STARTING` and proceeds to `events()` and `status()`.

The fake runner verifies coordinator behavior deterministically; this does not claim real-runner acceptance, which remains with the parent integration.
