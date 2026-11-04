# Cursor Project records handoff

工具：本机 Cursor Agent；显式 --model auto。这是实施者报告，不代替父 Agent 验收。

I'll implement only the Project records section: reading the task doc and existing patterns, then owning `src/projects/projects.ts` and `tests/projects.spec.ts`.Looking at sibling repositories and schemas for the same patterns.Sibling worktrees have similar repos — reading employees/approvals for the shared schema pattern.Implementing the project repository and tests from the task contract and git-worktrees path/Git patterns.Employees implementation is available — using it as the template.Cleaning up the integration-gap assertion, then running targeted tests.Project records are in place; only the two assigned files were added.

### Delivered
- `src/projects/projects.ts` — `initializeProjectSchema(db)`, `ProjectRepository` with `create` / `get` / `list` / `update` / `archive` / `snapshot`
- `tests/projects.spec.ts` — Git fixtures, path/symlink/overlap rejection, version races, snapshots, archive, schema rejection

### Behavior notes
- Schema key `project-schema` = `1`; future versions rejected before table writes; requires existing `kv`
- Canonical absolute Git root via `execFileSync` (outside tx); absent `worktreeRoot` allowed without creating dirs
- Paths immutable after create; archive is config-only (does not stop executions)
- Workspace name uniqueness + immutable version snapshots

### Checks run
- `pnpm exec vitest run tests/projects.spec.ts` — 10/10 passed
- `pnpm exec tsc --noEmit -p tsconfig.test.json` — passed

### Integration gap (for parent)
`LocalStore` does not call `initializeProjectSchema` yet — not wired into shared storage/init.
