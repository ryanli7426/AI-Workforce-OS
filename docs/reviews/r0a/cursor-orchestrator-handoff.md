# Cursor Auto orchestrator handoff

Implementation report only; parent review and integrated gates determine acceptance.

I'll read the orchestrator task doc and the existing APIs/contracts first, then implement only the three owned files.Dispatcher is present; checking it and the parallel task-app worktree for the LocalTaskService API.Implementing the orchestrator, mock Claude CLI fixture, and tests against the contracts.Cleaning up the orchestrator: storing roots as fields and removing the placeholder hacks.Writing the orchestrator test suite next.## Delivered (owned)

- `src/application/local-orchestrator.ts` — durable closed loop: capacity-aware schedule → intent dispatch → launch/stop handlers → reconcile (artifacts + Core evidence). Non-reentrant `tick`, synchronized `reconcile`, no auto-DONE/verify/retry, UNKNOWN retains slots, cancel before spawn uses `confirmProcessStopped`.
- `tests/fixtures/claude-task-cli.mjs` — mock Claude CLI (shebang, JSON result, modes via `FIXTURE_MODE=`).
- `tests/local-orchestrator.spec.ts` — 7 tests covering happy path→DONE, concurrency, cancel, FAILED paths, no double-start, eligibility filters, UNKNOWN + duplicate tick.

## Verification

`pnpm build && vitest run tests/local-orchestrator.spec.ts` → **7/7 passed**.

## Parent integration notes

| Dependency | Status |
|---|---|
| `src/orchestration/dispatcher.ts` | Already in worktree; removed invalid `repository.inTransaction` check so it matches the parallel dispatcher contract (please confirm from that worktree). |
| `src/application/tasks.ts` | Copied here from `workforce-cursor-task-app-20261104` **only to run tests** — not owned; replace/confirm from task-app deliverable. |
| Shared diffs (`execution-service`, `snapshots`, `client`) | Pre-existing in worktree; not touched by this task. |

No installs, commits, or pushes. No nested agents. No real model calls.
