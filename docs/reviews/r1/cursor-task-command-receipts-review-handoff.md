# Cursor Auto implementation report

Implementation report; parent integration/gates are the acceptance source.

I'll review the receipt-related corrections and stick to the same two files. First I'm locating those files and the current failing behavior.I have enough context to implement the four review corrections in the two owned files.Implementing schema preflight, receipt Ticket validation, and safer error classification.Corrections applied in the same two files only.

**1. Schema preflight** — `requireCommandSchema` now checks current main LAO schema, kv version 1, and actual `task_command_receipt` columns. Missing/corrupt table with version 1 fails at construction with no DDL.

**2. Replay validation** — Stored receipts must be a Ticket object with valid id/lifecycle/mandate actor+source matching constructor Owner+workspace and a real in-workspace Project. Scalars/foreign receipts reject as sanitized plain `Error` with no writes; legitimate replay still returns the original committed snapshot.

**3. Error classification** — Known Core business-state messages → `STATE_CONFLICT` (409). Unexpected DB/IO/receipt failures → generic non-`TaskCommandError` (`Command persistence failed`). INSERT-abort trigger regression proves Task/audit/intents rollback plus that classification.

**Verification:** `tsc` (src + test) pass; `vitest run tests/task-command-receipts.spec.ts` 14/14 pass. No other files edited; no installs/commits/pushes.
