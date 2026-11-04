# Cursor Auto execution-logs-review

Implementation report only. Parent corrections and integrated gates determine acceptance.

I'll review the execution-logs implementation and its tests, then fix the three issues you listed while keeping ownership limited to those two files.I'll inspect similar fail-closed and permission patterns in the repo, then implement the three fixes.Implementing fail-closed truncated-line handling, append-only double-read verification, and stricter permission/error sanitization.Updating tests for the fail-closed redaction rules and concurrent-append behavior.Named `fs` imports won't see Vitest spies, so I'll switch the implementation to a namespace import so the concurrent-append test can intercept real FD reads.ESM blocks `node:fs` spies, so I'll add a narrow test-only probe that lets regressions append between real FD reads without mirroring the verification logic.Corrections are in the two owned files only. `pnpm typecheck` and `vitest run tests/execution-logs.spec.ts` both pass (18/18).

**1. Fail-closed truncated tails** — After UTF-8 repair, truncated windows drop the leading partial line (through the first `\n`). No newline ⇒ discard the whole window. Prefix-outside-window `api_key=` / `Bearer` cases no longer leak suffixes; complete later lines (including multibyte) still return.

**2. Append-only concurrent growth** — Replaced size/mtime equality with a bounded double-read of the original range: identity + owner/mode rechecked on the after FD; growth allowed only when bytes match; truncation/rewrite rejected. Probe-driven regressions append/rewrite via real FDs between the two reads.

**3. Permissions / sanitization** — Main DB now requires private `0600` + owner. Uncertain FS/DB errors map to path-free messages (no raw credential-shaped paths).

Public `readExecutionLogs` API unchanged (`setExecutionLogsReadProbe` is test-only for the concurrent-append regressions). No commits/pushes/installs.
