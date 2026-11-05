# R1-C verification acceptance

Accepted after parent review and full `pnpm check`: **787 backend tests in57files,86 Web tests in10files,3 actual Chromium flows**; no skipped tests. Backend/Web types/builds, standalone Engine+SQLite without node_modules, compiled CLI smoke and dependency scan passed. CHECK.json records command/exit/counts; the original private gate log digest is preserved there.

## Actual behavior and evidence

- `tests/verification-acceptance.spec.ts`: actual loopback HTTP enqueue202/replay, compiled independent verifier survives API+SQLite shutdown, fresh observer applies authenticated report once, nonzero check produces completed/failed, newer waiver/version produces superseded without overwriting Core, authenticated in-flight cancellation produces confirmed terminal evidence. No fake Assignment/Execution rows are introduced.
- `tests/verification-runner.spec.ts`: actual compiled supervisor/wrapper, at-most-once start, fresh observer, unrelated caller cwd, signed/MAC-bound full request and strict check report, LaunchSpec tampering, output cap, valid result above256KiB, cooperative stop, killed wrapper missing proof rejected. Parent corrected the kill fixture to positively identify its current owned wrapper and separately terminate its current owned check group.
- `tests/verification-supervision.spec.ts`: direct exit+stream close+group absence, absolute shutdown bound, never-resolving callback abort/timeout, raw aggregate output limit and token-like redaction regression, retained uncertainty, no next check after cancellation.
- `tests/verification-jobs.spec.ts`, commands/provenance/coordinator/plan tests: real SQLite persistence, exact replay, atomic failure rollback, scope/version/identity validation, UNKNOWN occupancy, late original handshake recovery, queued versus launched cancellation, immutable used plan revision, changed trusted policy, no auto-DONE.
- `tests/controller-composition.spec.ts`: legacy execution-only schema remains usable without implicit install; orphan verification tables/future metadata are rejected. `tests/task-cli.spec.ts`: run-once shares foreground controller ownership; fixture cleanup waits for terminal evidence.
- `web/e2e/verification-flow.spec.ts`: production Web → authenticated compiled CLI API → actual foreground controller → actual detached check → Core provenance/application → explicit browser review of the exact fixture artifact. Dotted plan revision exercised end to end. The page first shows REVIEW with passed verification, then only the explicit fixture review reaches DONE. The original real-Claude task was not accepted.
- `COMPILED_CLI_PILOT.json`: compiled verification-plans-init/plans works from unrelated cwd with explicit init/configure, private plan file, compact metadata and exclusive no-overwrite behavior; no Agent Runtime invoked.

The REVIEW execution fixture is deterministic test setup, not a claimed real model execution. Actual verification subprocesses are real. No business documents, IM messages, user credentials or real production review were used. Browser credentials remain in memory; output/storage/URL checks passed. Screenshot: [verified fixture awaiting human review](verification-reviewed.png).

## Product limits preserved

Checks are trusted local executables with minimal environment; this is not an OS sandbox against malicious same-user code. Missing signed proof or uncertain process ownership retains UNKNOWN and prevents relaunch. API only enqueues; controller must run separately. Trusted plan updates require local Owner configuration and explicit API restart; initial registration refuses overwrite. Public job views include state and provenance metadata; detailed signed private report and partial process evidence remain in the private local data directory.

SSE, Runtime registry and filesystem scope hardening, real DingTalk business integration, multi-user organization/teams/workflows, knowledge/analytics/automation, OS deployment and72-hour operation are not claimed complete. DELIVERY_TRACKER preserves the entire product objective.
