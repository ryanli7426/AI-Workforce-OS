# R1 workforce/project management and execution list — parent acceptance

Date: 2026-11-05. Scope: governed single-Owner configuration operations and scoped execution browsing. Full product remains in progress.

Cursor Auto implemented management application/storage, HTTP routes, and Web forms in three isolated worktrees. Pi implemented scoped execution queries. Codex was explicitly launched as gpt-5.6-sol for a read-only async verification architecture review. Claude Code, with only Read enabled, independently audited management and integration. Parent owns all integration, actual browser acceptance, corrections and commits. Handoffs are supporting evidence, not final acceptance claims.

## Delivered

- Employee create (disabled by default), profile/config update, explicit enable/disable. Runtime membership checks use trusted configured runtime ID; referenced projects must be in the workspace and unarchived when new bindings are written. Enabled sensitive configuration changes require disabling first. Disable does not claim to stop existing tasks.
- Project create with real Git root/path preflight, immutable repository/worktree paths, business name/owner/type updates and explicit archive. Archive blocks future intake and does not terminate active execution.
- Resource state, version snapshot, Owner/reason audit and idempotency receipt commit atomically. Replay returns the original immutable snapshot after later edits or DB reopen; changed payload conflicts. Corrupt wrong-kind/id/body receipts fail closed.
- Git/filesystem preflight runs before write transaction using opaque same-repository one-use prepared-create capabilities; a second receipt check occurs inside transaction. Forged tokens and path work within active transactions are rejected. Reads/serve do not migrate schemas.
- HTTP management routes reject unknown/credential/actor/workspace fields, missing/duplicate keys and version conflicts, retain the global authenticated Host/Origin boundary and generic operational errors.
- Web forms preview actual requested values and require reasons/explicit confirmation. Edit snapshots and confirmed versions remain stable across polling;409 refreshes facts and requires a fresh decision. Ambiguous network retries retain the same key. Archived existing bindings remain visible/removable; profile-only updates do not rewrite unchanged project permissions.
- Execution list exposes real persisted records through scope-before-pagination SQL, state/project/employee/task filters, bounded cursor pagination, exact execution identity validation and detail/task links. UNKNOWN is not offered an unsafe restart action.

## Independent review dispositions

| Finding | Correction and evidence |
| --- | --- |
| Polling can overwrite edits or silently adopt a newer version | Immutable base employee/project snapshot and explicit stale/reopen behavior; behavior tests preserve pending versions and handle409. |
| Confirmation metadata omitted actual changes | Readable field/value preview for each command type, including membership, Runtime, limits, paths and archive/enable effects. |
| Replay result may be replaced or point at wrong resource | Kind/id bound to normalized command; exact original immutable repository snapshot equality; corruption/reopen tests. |
| Source-grep dependency test assumes initializer remains absent | Replaced with actual initializer/schema/empty-table behavior; future version preflight tested before other modules install. |
| Editing archived membership is a dead end (also independently found by Claude) | Render current archived/missing bindings, allow explicit removal, send only changed sensitive fields; unit and actual browser test confirm profile update preserves archived historical binding. |
| Empty employee patch claims a successful update | Missing all mutable fields now INVALID_COMMAND/HTTP400, with no receipt/audit writes. |
| Invalid repository path misclassified404/500 | Resource-not-found mapping now exact; filesystem ENOTDIR maps invalid input. Actual nonexistent/regular-file-parent tests return400 without leaking paths. |
| New management pages dropped existing task links | Restored scoped employee/project links; previous real browser task flow remains green. |

Parent also split the long UI implementation into shared confirmation/audit helpers and separate employee/project managers. Domain state is not implemented in the browser or HTTP layer.

## Validation and scope limits

`pnpm check` includes all backend/Web types, unit/process integration tests, compiled CLI, independent Core/SQLite smoke, dependency scan, production Web build and actual Chromium flows. Exact counts are in CHECK.json. The management browser flow uses real private SQLite and temporary Git, creates/updates/archives a project, creates/enables/disables/edits an employee, checks actual audit/versions, exercises archived membership, and confirms no Execution is launched. The previous task creation/approval/cancellation flow still passes. Runtime/model/IM calls are zero in these tests.

Explicit initialization adds management-schema1; existing databases must run `init` before the updated API starts. Old CLI read/controller paths retain the previous module compatibility boundary. Web employee creation currently offers the default claude-local binding; a generic Runtime registry/chooser remains to implement. Skills, teams, permissions UI, performance, project members/knowledge/workflows and full resource detail tabs remain incomplete.

Async verification is designed and its repository implementation is delegated separately. There is no asynchronous verify API/worker product acceptance yet. Verification remains the explicit CLI until durable jobs, supervised process termination, report provenance, stale-result guards, API and Web pass their own gates. Real DingTalk business target, multi-user governance, SSE, OS services and long-running soak remain outstanding.
