# Cursor Auto handoff

Implementation report only; accepted state is in MANAGEMENT_ACCEPTANCE.md.

I'll read the management page, its tests, and the review notes, then fix only those two files.Checking package scripts and how shared UI patterns handle similar state:Implementing immutable base snapshots, richer confirmation previews, and history actor display in both files.Updating the tests for base-snapshot behavior, confirmation field previews, and history actorId.The create-history assertion was matching the first render’s reason field; scoping it to the history panel.Parent review fixes are in `management.tsx` / `management.spec.tsx` only. Owned tests: **10/10 passed** via `./node_modules/.bin/vitest`.

1. **Base snapshot** — Edit/enable/archive bind an immutable `baseEmployee` / `baseProject` opened by the user (not live `query.data.find` + `useEffect`). Polling keeps the draft and original `expectedVersion`, shows a stale note + explicit reopen; submit still uses the base version. After **409**, preview+reason clear and the row is force-reopened from refreshed data so the old draft cannot act as the newest snapshot. Success updates the base from the mutation result; create stays separate; no optimistic writes.

2. **Confirmation preview** — Readable requested fields (name/role/projects/runtime/concurrency/timeouts, paths, owner/types, enabled/archive) instead of metadata-only.

3. **History** — Shows `actorId`, action, reason, and versions from the real history query.

4. **Types/tests** — Mocks use existing exported `ApiClient` types only; no sibling stubs.
