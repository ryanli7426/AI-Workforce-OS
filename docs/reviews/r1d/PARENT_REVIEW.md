# R1-D parent review

Implementation fallbacks: Codex CLI explicitly gpt-5.6-sol delivered storage, browser parser, design review and actual TCP acceptance; Claude delivered HTTP; pi delivered React. Four Cursor Auto implementation attempts failed authentication before producing code. A later status command reported logged in but an actual Auto final-review request again failed authentication; it is not counted as a completed review. Claude followup hit429 and pi followup returned malformed SSE; parent implemented remaining tests and reviewed integration. Private handoff hashes are recorded without copying process outputs or credentials.

## Resolved findings

- Retention resets only below greatest removed sequence, not at equality. SQLite high watermark survives pruning and is checked against retained rows/meta.
- Trigger definitions are validated against expected SQL, not only names. Queries/serve never install or repair schema; init is explicit and atomic.
- Ready follows backlog. HEAD disabled. Heartbeat deadline survives empty polls. Stream socket timeout is independent of ordinary10s API timeout and restored on cleanup.
- Shutdown tracks sessions through loop completion, cancels blocked drains, prevents DB access once closing starts. A genuine TCP acceptance failure traced to an unused Undici preconnection; dedicated pending-socket cleanup now closes only sockets with no HTTP request, preserving active handlers. Temporary diagnosis removed.
- Browser handler is bounded and abort-raced; cursor advances only after successful callback. Caller promises cannot be forcibly cancelled. Generation guards prevent stale React work affecting new connections.
- Keep50ms invalidation batching deliberately: acknowledgement means queued invalidation, not network refetch completion. Batch/cursor share lifetime and initial reset refreshes new runs. This is the documented disposition of the independent design recommendation to refetch per event.
- Task/Project invalidation includes dependent execution/verification/log views. Current public commands cannot reassign Task scope; defensive old/new audience tests do not claim complete multi-user cache revocation.
- Actual browser failure was an incorrect exact heading in the new test; corrected to the real AI员工管理 heading, with no production-page workaround.

Final main-worktree gate passed as recorded in CHECK.json. No new dependency or Core change; domain audit retention and human review authority preserved.
