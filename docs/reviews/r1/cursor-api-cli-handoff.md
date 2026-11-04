# Cursor Auto implementation report

Implementation report; parent integration/gates are the acceptance source.

I'll start by reading the task doc, AGENTS.md, and the owned files/contracts so implementation stays scoped to those two paths.Parent modules aren't in this tree yet — I'll locate parallel worktrees and study existing CLI/test patterns next.Pulling reviewed modules and contracts from the parallel auth, HTTP API, and command-receipts worktrees.Implementing `api-commands.ts`, then copying reviewed sibling modules so imports and tests can run against real code.Writing the test suite next, covering in-process CLI behavior and a real loopback compiled-process serve path.Validating `--allow-origin` during parse so invalid origins fail before any filesystem access.Parent already wired the schema hook — I may have overwritten it when copying. Checking the current state.Parent already hooks command schema into `initializeApplicationSchema`, so I'll adjust the mismatch test to corrupt the schema version instead.Removing the source-grep routing assertion (disallowed by the task) and reporting that gap in the handoff instead.Using the parent-supplied `requireCommandSchema` for readonly preflight instead of a duplicated check.Implemented only the two owned files: `src/cli/api-commands.ts` and `tests/api-cli.spec.ts`.

### Delivered
`runApiCommand(argv, io)` → `undefined` only for unknown commands:
- **`api-init --data-dir`** — readonly main/module/command preflight → `createLocalApiCredentials`; stdout `{path,createdAt}` only (never token); no mkdir/migrate/overwrite
- **`api-serve --data-dir [--port N] [--allow-origin URL]`** — host fixed `127.0.0.1`, port `0..65535` (default `4310`); origins via auth helper; load settings+credentials; `createApiServer` → listen → `{listening,address,workspaceId}`; SIGINT/SIGTERM → `app.close` + DB close + listener cleanup; no controller/Runtime

### Verification
- `tsc` (src + test): pass
- `vitest run tests/api-cli.spec.ts`: **7/7 pass** (includes real loopback `port 0` child via compiled `dist/cli/api-commands.js`, 401/auth/403 Origin, SIGTERM, DB reopen)

### Parent still owns (honest gaps)
1. **`src/cli/index.ts`** — wire `runApiCommand` before other dispatchers (not present; full `workforce` binary path not exercised)
2. Confirm/keep reviewed copies of `src/api/{auth,server}.ts`, `src/application/task-commands.ts`, `src/storage/command-receipts.ts`, and application-store schema hook (present in this worktree; not edited by this task)
3. Full `pnpm check` / smoke

No installs, commits, pushes, nested agents, or real Runtime/model calls.
