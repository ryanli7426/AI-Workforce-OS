# Cursor raw-output budget correction

Implementation handoff; parent gates remain authoritative.

I'll inspect the verification engine's output-byte accounting and the three owned engine files so we can debit raw accepted bytes instead of redacted stdout/stderr.I've confirmed the bug: debit uses redacted string lengths. Next I'll thread an internal raw accepted-byte count through finished outcomes and add the token-compression regression.Implementing the internal raw-byte debit and the token-compression regression next.Adding the regression test for token-like output that compresses under redaction.Fixing the token script so lines end with real newlines for proper redaction.Aggregate 1MiB accounting now debits **raw accepted bytes**, not redacted report strings.

### Change
In `src/verification/local-checks.ts`, finished `OwnedCheckOutcome` carries internal `acceptedOutputBytes` (not on the public report DTO). The supervised loop debits that count only. Exhausted budget + zero-output next check can still pass; any positive output fails; legacy per-check 1MiB unchanged. `model.ts` / `request.ts` untouched.

### Regression
Two ~600KiB Anthropic-token floods (each redacted well under 1MiB) must fail the second check; report JSON must not contain the raw token.

### Checks
- `tsc` (main + test) — pass  
- `vitest` `local-checks` + `verification-supervision` — **25 passed** (24 prior + 1 new)

Handoff: `docs/reviews/r1b/cursor-verification-engine-aggregate-bytes-handoff.md`
