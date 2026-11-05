# Cursor transport review

Implementation handoff; parent gates remain authoritative.

I'll start from the task doc and the four owned transport files, then apply the parent-review fixes without touching siblings.Next I'll inspect ENGINE exports and the Runner launch/request shapes those binding and FD-read fixes need to match.I have enough context to implement: shared FD-bound I/O in protocol, LaunchSpec binding in the client, remove the worker shim/catch-signing path, then harden tests.Next I'll rewrite the client with LaunchSpec binding, import.meta.url module resolution, and the shared FD I/O helpers.Two test failures to dig into: cancel missing `result.json`, and bulky stdout capped at 64KiB.Cancel was firing during `STARTING` before the wrapper could sign; bulky stdout was truncated by `process.exit` before flush. Fixing both tests.The cancel path is signing now; I'll loosen the runnerPid race by waiting briefly for exit before asserting.TRANSPORT fixes landed in the four owned files only. ENGINE `verifySupervised` is used directly (no shim / skip / unavailable fallback).

### Changes
1. **LaunchSpec binding** — `status` / `events` / `stop` / `collect` / observe compare private runner `request.json` spec to the immutable wrapper expectation; token format validated, never returned.
2. **FD-bound I/O** — shared helpers in `protocol.ts`: nofollow, exact 0600/0700, owned UID, bounded reads, stable fstat, final inode identity, trusted Darwin aliases only; short-write guards; FD `fchmod` + inode fencing; exclusive result publish (no blind `.tmp` rm).
3. **Module resolution** — compiled worker paths derived from `import.meta.url` (any cwd); constructor/queries create no files.
4. **Worker signing** — only engine `terminalConfirmed` results are signed; no message-regex inference after engine entry; preflight-only can sign `PREFLIGHT_FAILED`; signals before await setup.
5. **Report binding** — passed = exact plan order/ids/exit0/null signal/no reason; failed = nonempty plan prefix with real failure last; MAC embedded request must equal `options.request`; unknown fields rejected.
6. **8MiB** result bound consistently (`VERIFICATION_MAX_RESULT_BYTES`).

### Verification
- `pnpm typecheck` — pass
- `vitest run tests/verification-runner.spec.ts` — **16/16 pass** (pass, nonzero failed, auth stop→CANCELLED, kill→UNKNOWN, >256KiB result, streaming cap reject, LaunchSpec tamper, cwd-independent resolve, no skips)

No sibling edits, installs, or commits.
