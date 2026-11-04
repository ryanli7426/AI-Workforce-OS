# pi Core/SQLite 初稿审查

工具：pi，openai-codex/gpt-5.6-sol，只读工具；无 Shell。下列问题在父 Agent 集成时修复，详见 PARENT_ACCEPTANCE.md。

## Findings

1. **Blocker — newer source revisions are silently discarded.**
   A bound issue immediately returns its original Decision without comparing or recording the new revision (`src/core/evals.ts:134-145`). Assignment, approval, and retry then trust the stale `lifecycle.issue.closed` value (`src/core/lifecycle.ts:65-67`, `79-82`, `141-146`). Thus an issue accepted open at v1 can close at v2 and still launch. The test changes revision but checks only ticket identity (`tests/lao-core.spec.ts:21-27`). This contradicts revision/closure handling in `docs/AI_WORKFORCE_OS_ARCHITECTURE.md:373-376`.

2. **Blocker — an existing unversioned database can be silently promoted to schema 12.**
   The repository creates `kv` and enables WAL before schema validation (`src/storage/sqlite.ts:38-44`). `LocalStore` rejects an unversioned database only when `ticket` contains rows, then otherwise initializes it and stamps schema 12 (`src/storage/store.ts:17-31`). An unversioned database containing legacy `effect`, `outbox`, or thread state but no tickets would bypass quarantine and retain dispatchable legacy rows. Tests cover versioned schema 11 and unsupported numbered schemas, but not unversioned non-ticket state (`tests/lao-storage.spec.ts:96-130`).

## Not new regressions

- Connection/workspace-scoped source identity, Runner generation/locks, complete Execution/Artifact persistence, and operational Runtime/connectors are documented future work, not B0 migration defects (`docs/AI_WORKFORCE_OS_ARCHITECTURE.md:328-334`, `446`, `582-587`).
- NOTICE, LICENSE, and manifest coverage show no concrete attribution blocker from this static review.

## Recommendation

**Do not accept B0 yet.** Require revision-aware source updates/closure handling and read-before-write schema validation that rejects all pre-existing unversioned application databases. Add regression tests for both cases. CLI was not reviewed; no tests or commands were run per instructions.
