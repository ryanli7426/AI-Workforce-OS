# Cursor Auto task-cli handoff

Implementation report only; parent review and integrated gates determine acceptance.

I'll implement the CLI task commands from the task doc, owning only those two files. Reading the contract and existing APIs first.Next I'll pull the settings/tasks/orchestrator contracts and locate the real APIs those commands must call.Dependencies look incomplete; I'll inspect what's already in the tree and how neighboring modules are shaped.Checking sibling worktrees and the upstream repo for the dependency modules I should import, not reimplement.Reading the sibling worktree APIs so imports and tests match the real contracts.Implementing `task-commands.ts` against the real sibling APIs, then the tests.Cleaning unused imports, then writing the test suite.I'll stage the reviewed dependency modules for local verification, then add the tests.Running the targeted tests after a build so the orchestrator worker path resolves.Implemented user-operable Task CLI in the two owned files.

### Owned
- `src/cli/task-commands.ts` — `runTaskCommand(argv, io)` → `Promise<number|undefined>` (`undefined` only for unrecognized commands)
- `tests/task-cli.spec.ts` — coverage for configure, create→approve→queue, strict flags/JSON, no implicit DB creation, stale/missing verify/review, cross-workspace denial, readonly executions, fixture `run-once`

### Behavior
- Commands: `configure`, `task-create`, `task-approve|reject|cancel|retry`, `task-review`, `task-verify`, `run-once`, `executions`
- Strict option parsing; stable JSON on stdout; redacted errors + nonzero exits
- Readonly main/module schema validation before `LocalStore` / `applicationRepositories`; no implicit init/migrate
- Create JSON fields: `project`/`issue`/`title`/`description`/`taskType`/`priority` → service `projectId`/`issueId`
- Verify uses current Task result + `LocalVerifier` / `ArtifactStore`; `--waive` or `--checks-file` only (no `--state passed`)
- `run-once` requires configured runtime command; injects allowlisted env via `validateRuntimeEnvironment` (never echoed)

### Gates
| Gate | Result |
|------|--------|
| `pnpm build` | pass |
| `tsc --noEmit -p tsconfig.test.json` | pass |
| `vitest run tests/task-cli.spec.ts` | **11 passed, 1 skipped** (skip = pending-deps guard when fixture absent; fixture was present so `run-once` ran) |
| `vitest run tests/task-cli.spec.ts tests/cli.spec.ts` | **28 passed, 1 skipped** |

### Parent note
For local verification, reviewed sibling copies of `settings.ts`, `local-orchestrator.ts`, `local-checks.ts`, `claude-task-cli.mjs`, and the fixed `dispatcher.ts` were staged so imports resolve. Replace/confirm with your reviewed versions on integration; no installs/commits/pushes were done.
