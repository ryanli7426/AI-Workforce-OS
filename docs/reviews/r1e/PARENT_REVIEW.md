# R1-E parent review and disposition

Parent implemented architecture, interfaces, integration, tests and docs. Two local Codex CLI tasks explicitly requested gpt-5.6-sol for scope design and independent implementation review; the implementation task received a focused correction review. These are reviewed local CLI delegates, not a claim that Cursor authentication recovered. No new real Runtime/model task or IM action occurred.

## Resolved code-review findings

1. Mutable driver ID alone cannot identify historical output semantics. Added explicit positive protocolVersion to trusted descriptors; stable SHA256 fingerprint covers driver ID, protocol version and ordered capability values. New Execution.runtimeRevision persists the fingerprint in existing JSON records and participates in reservation identity/replay comparison. No table migration or query-triggered upgrade occurs. Recovery checks driver+fingerprint before parsing terminal output or releasing Assignment. Same ID with protocol2 or changed capabilities invokes no wrong parser and leaves occupancy intact. Incompatible driver semantics require a version bump; developer factories are trusted code, not an adversarial plugin sandbox.
2. runtimes was initially coupled to ExecutionRepository. It now branches before any database validation/open, verifies only the existing private directory and settings, and reads built-in metadata. Missing/corrupt DB does not block diagnostics; missing settings are never created. Tests verify both missing and corrupt DB bytes remain untouched. API startup continues requiring its actual application DB; only CLI diagnostics are decoupled.

## Additional parent safeguards

- Fixed legacy identity is pinned to the known original Claude print/JSON capability snapshot. It is not recomputed from future current metadata. Only absent runtimeRevision invokes this mapping for legacy Claude; explicit null/corrupt revision fails closed. Arbitrary custom legacy protocols do not get guessed.
- Actual legacy fixture tests persist null, observe rejection/retained Assignment, then restore a genuinely missing legacy field and recover once using the fixed original protocol.
- Registry snapshots/freeze metadata, checks adapter identity/capabilities, clones request/results, validates LaunchSpec, preserves task/execution identity/cwd/command and limits execution budgets before spawn.
- Unknown drivers reject before scheduling. Core remains independent, process IO stays outside transactions, and Runner owns stop/status/collect/recovery. Completed historical Assignments are not reinterpreted by later configuration changes.
- Public catalog strips command/environment and separates configured from health:not_checked. Strict Web DTO rejects unexpected fields, invented health and orphan/duplicate IDs. No simulated active-input/resume/pause commands were added.

## Scope design disposition (still open)

Independent design correctly identifies the absence of OS containment. R1-E reports filesystemIsolation:false and records the next Provider/negative-probe plan. It does not claim to deliver that protection or install/upgrade the user's Runtime. Newer Claude permission switches, safe-mode/OAuth behavior and any external sandbox version require actual compatibility/probe evidence before activation. Candidate domains/path exceptions in the design report are proposals, not an approved broad profile. No hook/prompt/worktree-only fallback will be labelled strong containment.

## Verification

Full final pnpm check passed after all corrections: 836 backend tests, 110 Web tests and 5 Chromium flows, no skips. Logs are captured by CHECK.json. Independent correction review reported resolved with no remaining high/medium findings in its scope. It covers types/build, all backend and Web tests, Core + SQLite without node_modules, compiled CLI smoke, dependency scan and five production Chromium flows. Runtime screenshot is from the final production build and was visually reviewed. All acceptance models/processes are owned fixtures; historical real Claude remains REVIEW. This phase is registry/catalog delivery, not complete Runtime isolation, multi-instance routing, real DingTalk or full product completion.
