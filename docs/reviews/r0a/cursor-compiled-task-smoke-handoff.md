# Cursor Auto compiled-task-smoke handoff

Implementation report only; parent review and integrated gates determine acceptance.

I'll read the task doc and AGENTS.md first, then inspect the real CLI/contracts before writing only `tests/compiled-task-cli.spec.ts`.Checking related task docs and any prior work for the exact CLI command shapes.Sibling worktrees have the reviewed implementations — I'll inspect their real CLI contracts and fixtures so the smoke test matches them.Writing the compiled CLI E2E smoke suite against the documented contracts, with explicit dependency checks and no invented modules.Rechecking which dependencies are present — the missing list looks incomplete.Parent is copying deps. Checking what's landed and refining the gate.Updating the dependency gate to also detect missing async `runTaskCommand` routing in `index.ts`.Implemented `tests/compiled-task-cli.spec.ts` only. No dependency files invented or modified.

### What the smoke covers
Real `node dist/cli/index.js` child processes from an unrelated cwd, absolute paths, private temp data/Git/mock Claude under the test root, cleanup of owned PIDs only. Cases:

1. Readonly commands on missing storage leave no DB  
2. Invalid Task JSON types rejected (no coercion)  
3. Configure exclusive  
4. Premature `task-review` cannot complete  
5. Full path: init → configure → project-create → employee-create/enable → task-create → approve → repeated `run-once` → REVIEW → content check → `task-verify` → version-bound `task-review` → DONE  

### Actual results
| Gate | Result |
|------|--------|
| `pnpm build` | pass (produces `dist/cli/index.js`, `dist/runner/worker.js`) |
| `vitest run tests/compiled-task-cli.spec.ts` | **1 failed, 5 skipped** |

E2E tests stay skipped until blockers clear. Dependency gate currently reports:

- **missing file:** `src/cli/task-commands.ts`
- **missing file:** `src/application/local-orchestrator.ts`
- **pending integration:** `src/cli/index.ts` async routing of `runTaskCommand` before sync `runCli` (parent-owned; not edited here)

### Already present (parent copies)
`src/cli/index.ts` (management: project/employee/init schema), `src/config/settings.ts`, `src/application/tasks.ts`, `src/verification/local-checks.ts`, `src/orchestration/dispatcher.ts`, plus built `dist/`.

No installs, commits, pushes, or nested agents.
