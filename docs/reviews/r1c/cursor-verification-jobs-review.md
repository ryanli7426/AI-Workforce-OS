# Cursor storage review

Implementation handoff; parent gates remain authoritative.

I'll start from the task doc and owned model/storage/tests, leave `request.ts` untouched, then apply the seven review fixes.Next I'll inspect the parent request contract and the apply/cancel paths that need the ordered-check and STOPPING fixes.I'll align storage with the parent request parser and implement the apply, cancel, UNKNOWN, list, and application fixes.Implementing the storage fixes in logical order, starting with helpers and `apply`/`assertEventSemantics`.Replacing `jobFromRow` and removing helpers made redundant by the parent request parser.Updating `apply`, `list`, `recordApplication`, and `persist` next.Tightening CANCELLED record semantics, then updating the tests.Parent review fixes are in owned storage/tests only; `request.ts` untouched.

**Fixes**
1. **apply** checks prior exact event before terminal immutability — authenticated replay after `recordApplication` returns current job with no audit/version bump; conflicting duplicate still rejects.
2. **STOPPING + cancelRequested** accepts late contiguous STARTING/RUNNING, pins identity/sequence, stays STOPPING until terminal proof — covered by cancel-before-first-event → 1 STARTING → 2 RUNNING → 3 STOPPING → 4 CANCELLED.
3. **Unpinned UNKNOWN** at `lastSequence=0` accepts only sequence-1 STARTING to pin; other first events reject; pinned same-runner rules unchanged.
4. **list** rejects unknown option keys and duplicate statuses.
5. **jobFromRow** validates request via parent parser, scalars/PIDs/dates/terminal/application/cancel shapes; errors stay generic (no raw leak).
6. **recordApplication** exact retry is idempotent with original `expectedVersion` (pre-bump) and identical `at`; flip/digest changes still reject.

**Gates:** `tests/verification-jobs.spec.ts` 18/18; `pnpm typecheck` clean.

**Parent note (`request.ts`):** storage wraps `parseVerificationRequest` for the immutable request contract and keeps a local forbidden-field pre-check so secret values never appear in errors. Parent parser messages are generic (`Invalid verification request`); timestamps now require canonical `toISOString()` form to match. No sibling edits.
