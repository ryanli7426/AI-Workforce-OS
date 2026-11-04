# Cursor Auto controller-lease-review

Implementation report only. Parent corrections and integrated gates determine acceptance.

I'll review the controller-lease module and fix the listed bugs in only the same two owned files.Checking worker patterns and whether inspect/stop already treat a missing dataDir specially:I have a clear picture of the six bugs. Implementing fixes in both owned files now.Implementing the focused fixes across creation helpers, ownership checks, recovery stop cleanup, and inspect/stop missing-dir behavior.Updating tests for the corrected contracts and the new regression cases.Fixing incorrect `expect().toThrow` usage in the new tests.Corrections are in `src/application/controller-lease.ts` and `tests/controller-lease.spec.ts` only.

### Fixes
1. **shouldStop** — Throws sanitized ownership-lost/unknown on lost lock/owner identity, content mismatch (token/pid/startedAt even same inode), mode/uid drift, or IO. Absent stop → `false`; valid mismatched token → `false`; malformed stop → fail closed.
2. **Dead-owner recovery** — Before installing the replacement owner, removes only a verified stale `stop.json` matching the dead owner token+inode; foreign/malformed stop fails closed and leaves `recovery.claim`. Regression: stop → kill child → recover → release → reacquire.
3. **Creation helpers** — `fchmodSync` on owned FDs (file + directory); cleanup unlinks/rmdirs only the created inode; partial lock `rmdir` is identity-fenced.
4. **requestControllerStop** — Rejects unsafe existing stop (symlink/wrong type/foreign/malformed); verifies owner identity+contents before and after write.
5. **inspect/stop** — Missing `dataDir` → `{state:'stopped'}` / `{requested:false}` with no creation; permission/symlink still fail closed.
6. **release** — Ownership loss throws instead of silent success; exclusive `recovery.claim` preserved; no live-owner mutation or process signaling.

### Checks
- `pnpm exec vitest run tests/controller-lease.spec.ts` — **18 passed**
- `pnpm exec tsc -p tsconfig.json --noEmit` — clean
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — clean
