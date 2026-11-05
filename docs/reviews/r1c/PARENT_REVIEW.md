# R1-C parent review — async verification (accepted)

Cursor Auto owns storage, engine, transport, HTTP, CLI and Web implementations in disjoint worktrees. Codex CLI was explicitly launched with gpt-5.6-sol for command/Core tests and genuine detached-worker acceptance. Claude Code provided deterministic coordinator tests and an independent launch-identity finding. pi provided read-only contract review. Parent owns architecture, integration, corrections and final gates; agent self-reported checks are not acceptance.

## Resolved findings

- Preserve STOPPING across late STARTING/RUNNING events; allow only authenticated original first STARTING to recover an unpinned UNKNOWN; exact event replay after application adds no audit/version.
- Confirm direct child exit, stream close and process-group absence with an absolute termination deadline. Bound even a never-resolving process callback; no uncertain process is released as failed.
- Debit the aggregate1MiB output budget using raw consumed bytes, including token-like output compressed by redaction. Public reports omit the internal accounting field.
- Bind generic Runner launch command/args/cwd/IDs/generation to immutable verification input before any observe/stop/collect. Collect requires both real outer terminal evidence and a validated MAC-bound engine result. Killed wrapper or missing report remains UNKNOWN.
- Private evidence reads use bounded nofollow descriptors, exact mode/UID, single-link files, ctime/mtime/inode and final path/parent fencing. Read paths never chmod. Trusted plans reuse those helpers and are registered exclusively.
- Validate the actual start handshake identity (Claude's failing regression), then ingest contiguous events. Reserve and beginLaunch commit before process IO; reconciliation never starts an existing job.
- Commit terminal evidence, exact Task verification and application result together. Newer Task versions or changed trusted policy become superseded only after confirmed terminal proof. No automatic DONE.
- Infrastructure FAILED requires a failure code and no check outcome; completed nonzero checks are COMPLETED/outcome failed. Exact application retries accept only original expectedVersion/time/digest/outcome.
- Previously used plan id/revision cannot silently identify changed check commands in the same scope; full plan content is transitively bound through immutable request SHA256 and signed report digest.
- run-once now shares the controller lease to avoid racing scheduling. Its legacy counters remain at top level; verification counters are additive. Fresh fixture cleanup waits for authenticated terminal evidence before deleting files.

## pi findings requiring context

The internal trusted LocalTaskService.verify method continues accepting legacy verifier evidence. It is not an HTTP command and there is no public passed/provenance setter. Existing synchronous task-verify obtains evidence from the actual LocalVerifier, with explicit Owner waiver as not_required. Core is deliberately independent of worker cryptography and DB jobs; making it import verification infrastructure would violate architecture. Async evidence authority is checked in the coordinator; user-facing API only selects trusted plans or cancels. Current policy is now revalidated in Core as well.

Task IDs are globally unique in the Core ticket table. Active verification uniqueness by ticket_id intentionally protects that one aggregate regardless of malformed/foreign request scope; public commands first prove actual Task access. It is not a per-owner alias namespace.

No explicit plan digest field is needed in Core: reportSha256 hashes a canonical envelope containing requestSha256; that hash includes all immutable plan checks. The full request is durably stored. Same plan identity content reuse is additionally rejected during reservation.

## Acceptance progress

Four real detached worker/API restart tests passed in the main worktree. Chromium exercised Web enqueue → foreground controller → compiled detached check → Core evidence/application → explicit fixture review. Parent corrected the initial invented Web command-result DTO, composed the existing authenticated private request transport, and corrected stale CLI-only UI text. Final pnpm check passed:787 backend,86 Web tests and3 Chromium flows; see CHECK.json. Same-user check binaries are trusted local code, not OS-sandboxed; do not claim adversarial isolation. Full product gaps in DELIVERY_TRACKER remain active.
