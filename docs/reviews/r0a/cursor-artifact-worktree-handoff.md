# Cursor Auto artifact-worktree implementation handoff

Implementation report only. Parent review, corrections and integrated gate results are tracked separately.

I'll read the repo contract and the Cursor mainline task section assigned to me, then implement only the snapshot files.Next I'll inspect the existing snapshot implementation, related Git worktree APIs, and the current tests.I'll study how GitWorktreeManager validates linked worktrees and any prior artifact handoff notes so the snapshot changes match.I'll inspect a real linked worktree layout and how `nlink` / independent file checks behave for the snapshot root.I have enough context: I'll update linked-worktree validation, baseRevision deletion tracking, private artifact roots, and safer Git invocation, then extend the tests.Next I'll fix the repository validation path and private artifact-root checks.Private-directory checks must apply only to the artifact root, not Git worktree paths — fixing that.Updating the test file with linked-worktree coverage and the other required cases.All 23 tests passed. Running typecheck next.Linked-worktree artifact capture is implemented in the two owned files only.

### Changes
`src/artifacts/snapshots.ts`
- Accepts safe Git linked worktrees: regular-file `.git`, absolute/canonical `--absolute-git-dir` + `--git-common-dir`, metadata under `commonDir/worktrees`, `gitdir` backlink to this worktree `.git`, unique `worktree list` registration with matching HEAD
- Still accepts normal repos; rejects symlinks, submodule/arbitrary `.git` redirection, forged backlinks
- `deletedPaths` from `diff <baseRevision>` (committed + staged), not `diff HEAD`
- Private artifact root (`0700`); rejects preexisting shared roots without chmod
- Fixed `/usr/bin/git` argv + controlled env; errors never include raw stderr

`tests/artifact-snapshots.spec.ts`
- Committed/staged deletions vs base, shared-root rejection, independent file copies
- Real `GitWorktreeManager` capture/verify, committed deletion in worktree, legitimate vs forged backlink, arbitrary `.git` redirect

### Checks run
| Check | Result |
|---|---|
| `pnpm exec vitest run tests/artifact-snapshots.spec.ts` | **23 passed** |
| `pnpm typecheck` | **passed** |
| Full `pnpm check` / 387-test baseline | **not run** |

### Unresolved integration (parent)
- Wire Runtime capture `cwd` to `GitWorktreeManager` worktree paths (must be worktree toplevel)
- Consumers (`LocalVerifier`, dispatcher, CLI) still need parent integration
- No commit/push; docs/smoke/handoff updates are parent-owned
