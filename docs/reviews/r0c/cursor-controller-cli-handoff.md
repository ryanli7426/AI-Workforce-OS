# Cursor Auto controller-cli

Implementation report only. Parent corrections and integrated gates determine acceptance.

I'll read the task doc, AGENTS.md, and the files I'm allowed to own before implementing against real APIs.Next I'll inspect the operations APIs and Task CLI patterns the controller commands need to call.Operations modules aren't in this worktree yet — I'll check sibling worktrees and reviews for the real APIs.Reading the three parallel dependency worktrees for their real export contracts.Dependency modules exist in sibling worktrees but aren't copied here yet. Implementing against those APIs, then verifying with temporary links if needed.Implementing `controller-commands.ts` now.Fixing the awkward `realpathSync` import and cleaning up a few issues.Writing the test suite next, then linking sibling dependency modules so we can run real tests.Fixing `initDataDir` settings construction and checking whether `defaultSettings` allows a custom poll interval.Cleaning unused imports and verifying the implementation once more.Writing the event file before stdout so a sink failure fails closed without a partial emit.Implemented only the two owned files: `src/cli/controller-commands.ts` and `tests/controller-cli.spec.ts`.

### Delivered
`runControllerCommand(argv, io)` with:
- **`start --foreground --data-dir`** — readonly schema check → settings/runtime → lease → `LocalTaskService`/`LocalOrchestrator` → `runControlLoop`; stop poll 75ms + SIGINT/SIGTERM; events to stdout + `controller-events.jsonl` (0600, 16MiB, ≤2 rotations); summary `{ticks,errors}` only
- **`stop`** — `requestControllerStop` only; `{requested,state,pid?}`; missing dir → `{requested:false,state:'stopped'}`, no storage created
- **`controller-status`** — `inspectController` readonly
- **`logs`** — `readExecutionLogs` with bounded `--tail-bytes`

### Test outcomes
With temporary copies of the three sibling ops modules (removed afterward; not left in this worktree):

**10 passed / 1 failed**

Failed gate (expected): compiled child-process test — `src/cli/index.ts` does not yet route `runControllerCommand` (parent-owned).

### Parent needs to supply
1. `src/application/control-loop.ts`
2. `src/application/controller-lease.ts`
3. `src/observability/execution-logs.ts`
4. `src/cli/index.ts` routing: `runControllerCommand` before `runTaskCommand` / `runCli`

No installs, commits, pushes, nested agents, or real model calls.
