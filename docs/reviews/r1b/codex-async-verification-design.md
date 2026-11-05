# Codex gpt-5.6-sol async verification architecture review

Read-only implementation input; recommendations are subject to parent decisions in docs/tasks/R1_VERIFICATION_JOBS.md. No asynchronous verification runtime is claimed delivered by this document.

I’ll trace the repository’s actual verification and lifecycle paths, then map a minimal durable job design onto existing transaction, lock, and audit primitives. I’ll stay read-only and avoid the concurrent employee/project and API-transport areas.

The code already separates “verification evidence” from approval, but the current verifier is a one-shot filesystem/process utility rather than a durable control-plane job. I’m now checking exactly where its child-process termination proof, report persistence, and CLI-to-Core handoff are weak or reusable.

## Conclusion

The current `LocalVerifier` is not safe as the implementation behind an asynchronous Web verification API. It is useful as a hardened check-execution prototype, but it lacks durable job identity, supervision across controller/HTTP lifetime, authenticated cancellation, an `UNKNOWN` outcome, authoritative report provenance, scoped idempotency, and atomic application to the Task.

The minimal production-capable design is a dedicated durable `VerificationJob` aggregate plus a detached verification worker. Reuse the existing artifact validation, process-group handling, Runner file protocol patterns, controller loop, Core review gate, and SQLite transaction discipline. Do not reuse `ExecutionRepository` as the verification job store, and do not run `LocalVerifier.verify()` inside an HTTP request or long-lived intent handler.

No files were changed and no tests or external services were run.

## Specific current risks

- `authorized: true` is merely caller-supplied data, not authority. [`parseVerifyInput()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/verification/local-checks.ts:227) accepts the boolean without tying it to an authenticated principal, workspace, Task version, or policy.

- The CLI performs the entire verification synchronously, then mutates the Task directly. [`handleTaskVerify()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/cli/task-commands.ts:636) holds the process until every check finishes and calls `tasks.verify()` without an idempotency receipt or `expectedVersion`.

- The owner command facade has no verification command at all. [`LocalTaskCommand`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/application/task-commands.ts:50) supports review but not verification. The HTTP server likewise exposes review but no verification resource or asynchronous job route at [`POST .../review`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/api/server.ts:726).

- Core only checks `executionId` and `artifactRevision`. [`Lifecycle.verify()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/core/lifecycle.ts:142) does not bind `artifactId`, verification job identity, plan revision, or report digest. Any trusted caller reaching `LocalTaskService.verify()` can assert passed/failed/not-required at [`tasks.ts:418`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/application/tasks.ts:418).

- `LocalVerifier` conflates verification failure with uncertain process ownership. If descendants may still exist or stream closure is unconfirmed, [`runCheck()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/verification/local-checks.ts:469) returns a normal result with `reason`; [`verify()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/verification/local-checks.ts:584) converts that to `failed`. It needs an `UNKNOWN` supervisor state instead.

- Startup failure is also insufficiently proven. At [`local-checks.ts:419`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/verification/local-checks.ts:419), a child with a PID is killed best-effort and immediately reported as a failed check without waiting for confirmed process-group death.

- There is no external abort mechanism. `runCheck()` only reacts to its timeout/output conditions. HTTP disconnect, controller shutdown, or an Owner cancellation cannot be propagated through an authenticated stop channel.

- A controller or host-process crash leaves no durable request, heartbeat, sequence log, current check PID, or recovery cursor. Because checks are detached process groups, a killed verifier process can leave a live check behind.

- The only report is unsigned JSON. [`persistReport()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/verification/local-checks.ts:319) fsyncs the file but not the containing directory and records no digest in SQLite or Task audit. The CLI trusts the in-memory return rather than independently authenticating the persisted report.

- On ordinary exceptions, [`LocalVerifier.verify()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/verification/local-checks.ts:607) deletes the entire destination, destroying useful recovery evidence. A hard crash instead leaves an unclassified partial directory that cannot be resumed because pre-existing destinations are rejected.

The execution Runner has the correct conservative patterns to copy:

- Existing request directories are observed rather than respawned by [`RunnerClient.#resumeExisting()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/runner/client.ts:212).
- Unconfirmed process-group or stream closure produces `UNKNOWN` in the worker at [`worker.ts:438`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/runner/worker.ts:438).
- Execution launch reserves durable state before the external start and refuses to relaunch `UNKNOWN` at [`ExecutionService.start()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/application/execution-service.ts:32).
- `ExecutionRepository` pins sequence, generation, runner identity, and terminal immutability at [`repository.ts:290`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/execution/repository.ts:290).

Its implementation should be reused as a design pattern, not reused as the job table: execution rows require Assignment/runtime/cwd semantics and enforce active Ticket/Assignment/worktree uniqueness that does not describe verification.

## Recommended architecture

```text
Authenticated Owner command
        │
        ▼
VerificationCommands ── transaction ──► verification_job(PENDING)
        │                                  + idempotency receipt
        │                                  + audit(requested)
        ▼
HTTP returns 202 immediately

Controller VerificationCoordinator
        │ claim PENDING → STARTING transaction
        │
        ├── outside transaction: detached VerificationWorker.start()
        │
        ▼
private request/state/events/report directory
        │
        ├── immutable artifact verification and copy
        ├── sequential supervised checks
        ├── authenticated stop polling
        └── terminal report + digest + event

Controller reconciliation
        │ read/validate files outside transaction
        ▼
single transaction:
  persist events/result
  recheck Task version + execution + artifact + policy
  apply Core verification evidence or mark SUPERSEDED
  append audits
```

The API must only enqueue and query jobs. It must never await `LocalVerifier.verify()`.

### Authority and plan selection

The create API should accept a trusted verification plan reference, not arbitrary executable paths from a Web body:

```ts
interface CreateVerificationRequest {
  expectedVersion: number
  executionId: string
  artifactId: string
  artifactRevision: string
  planId: string
  planRevision: string
  reason: string
}
```

Resolve `planId + planRevision` from frozen, trusted server configuration. Persist the fully normalized plan and its canonical SHA-256 in the job so later configuration changes cannot alter queued work.

The authenticated principal already has an appropriate foundation: the server requires the principal’s Owner and workspace to exactly match settings at [`server.ts:497`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/api/server.ts:497). Pass that principal into `VerificationCommands`; never put `authorized` in a DTO.

A waiver should be a separate Owner command. Automated workers may report only `passed` or `failed`; only explicit Owner authority may produce `not_required`.

### Job state machine

Use:

```text
PENDING → STARTING → RUNNING → COMPLETED
                   ↘ FAILED
                   ↘ STOPPING → CANCELLED
                   ↘ UNKNOWN

UNKNOWN → RUNNING | STOPPING | COMPLETED | FAILED | CANCELLED
          only from authenticated observation of the same worker

Any active state → SUPERSEDED
          only after valid terminal evidence cannot be applied to the bound Task
```

`COMPLETED` carries `outcome: passed | failed`. `FAILED` means verifier infrastructure failed with confirmed termination. `UNKNOWN` means termination or ownership is not proven.

There must be no transition from `STARTING`, `RUNNING`, or `UNKNOWN` back to `PENDING`, and no second spawn for the same `verificationId`.

## Schema

Add an explicitly versioned `verification-schema` module:

```sql
CREATE TABLE verification_job (
  verification_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,

  expected_task_version INTEGER NOT NULL CHECK (expected_task_version >= 0),
  execution_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_revision TEXT NOT NULL,
  policy_version TEXT NOT NULL,

  plan_id TEXT NOT NULL,
  plan_revision TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),

  status TEXT NOT NULL CHECK (status IN (
    'PENDING','STARTING','RUNNING','STOPPING',
    'COMPLETED','FAILED','CANCELLED','UNKNOWN','SUPERSEDED'
  )),
  version INTEGER NOT NULL CHECK (version >= 1),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('passed','failed')),

  lease_owner TEXT,
  lease_until INTEGER,
  launch_attempted_at TEXT,

  runner_id TEXT,
  runner_pid INTEGER,
  current_process_id INTEGER,
  last_sequence INTEGER NOT NULL DEFAULT 0,

  cancel_requested_at TEXT,
  cancel_requested_by TEXT,
  cancel_reason TEXT,

  report_sha256 TEXT,
  report_relpath TEXT,
  error_code TEXT,
  error_detail TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE UNIQUE INDEX verification_active_ticket
ON verification_job(ticket_id)
WHERE status IN ('PENDING','STARTING','RUNNING','STOPPING','UNKNOWN');

CREATE TABLE verification_runner_event (
  verification_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  PRIMARY KEY (verification_id, sequence),
  FOREIGN KEY (verification_id) REFERENCES verification_job(verification_id)
);

CREATE TABLE verification_audit (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  task_version INTEGER,
  runner_id TEXT,
  report_sha256 TEXT,
  FOREIGN KEY (verification_id) REFERENCES verification_job(verification_id)
);

CREATE TABLE verification_command_receipt (
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  command_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_sha256 TEXT NOT NULL,
  verification_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, owner_id, command_scope, idempotency_key)
);
```

Use scopes such as:

- `task:{ticketId}:verification:create`
- `verification:{verificationId}:cancel`
- `task:{ticketId}:verification:waive`

This is intentionally more precise than the existing globally Owner-scoped task receipt key.

## Transaction boundaries

Create transaction:

1. Replay/conflict-check the scoped receipt.
2. Load the Owner/workspace-scoped Task.
3. Require `REVIEW`, exact `expectedVersion`, current result, policy version, and exact `executionId + artifactId + artifactRevision`.
4. Insert `verification_job`, audit, and receipt atomically.
5. Commit and return `202`.

No artifact reads or process work occur here.

Dispatch:

1. In a short transaction, atomically claim only `PENDING` and change it to `STARTING`.
2. Commit.
3. Outside SQLite, create the private request directory and start the detached worker.
4. Persist observed events in later short transactions.

Completion:

1. Outside SQLite, validate the request file, worker identity, contiguous events, terminal proof, report bytes, report digest/MAC, and every bound identifier.
2. In one transaction, reload the job and Task.
3. If Task status, version, policy, execution, artifact ID, and revision still match, apply Core verification evidence and mark the job `COMPLETED`.
4. Otherwise retain the valid report but mark the job `SUPERSEDED`; never mutate the newer Task.
5. Append both verification audit and Task evidence audit in that transaction.

Cancellation:

1. Owner command transaction records the cancellation request and audit; it does not claim cancellation succeeded.
2. Outside SQLite, write an authenticated stop request.
3. Mark `CANCELLED` only after process-group death, direct-child exit, stream closure, report/log durability, and a terminal worker event are all confirmed.
4. Otherwise retain `STOPPING` or `UNKNOWN`.

Add the same defensive assertion used by [`IntentDispatcher`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/orchestration/dispatcher.ts:129): worker launch, artifact verification, file reads, and waits must fail immediately if `db.isTransaction` is true.

## Recovery rules

- `PENDING` with no launch claim is safe to claim.
- An expired `STARTING` claim becomes `UNKNOWN`, never `PENDING`.
- `STARTING/RUNNING/STOPPING/UNKNOWN` with an exact private request directory is observed under the same `verificationId`; it is never respawned.
- A matching live worker resumes event ingestion.
- A matching terminal report is idempotently applied.
- Missing, corrupt, conflicting, stale, or unverifiable ownership remains `UNKNOWN` and keeps the active-job uniqueness lock.
- If the request directory exists but state is incomplete, do not delete it.
- Explicit reconciliation may re-observe or record confirmed termination. It must not “retry” the same ID. A new job requires the old process to be conclusively absent or terminal.
- Controller restart should first reconcile verification jobs, following the existing control-loop startup ordering at [`runControlLoop()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/application/control-loop.ts:139).

## Worker and report requirements

Refactor reusable portions of `local-checks.ts` into a check engine, but run them only inside a detached verification worker.

Required changes:

- Accept an `AbortSignal`/authenticated stop predicate.
- Persist `RUNNING` state with runner ID, worker PID, current check ID, child PID, heartbeat, and monotonically increasing sequence.
- Record check exit code, signal, timeout, output limit, and process-group proof.
- Treat surviving descendants, missing close, lost worker ownership, or durability failure as `UNKNOWN`, never as a failed check.
- Fsync logs, report, event log, and containing directory before emitting the terminal event.
- Keep partial evidence on failure.

The report should bind at least:

```ts
interface VerificationReportV1 {
  version: 1
  verificationId: string
  ticketId: string
  expectedTaskVersion: number
  executionId: string
  artifactId: string
  artifactRevision: string
  policyVersion: string
  planId: string
  planRevision: string
  planSha256: string
  requestSha256: string
  runnerId: string
  outcome: 'passed' | 'failed'
  checks: VerificationCheckResult[]
  startedAt: string
  finishedAt: string
}
```

Store canonical report SHA-256 in SQLite and in Task audit. An HMAC using the per-job private launch token can detect substitution before ingestion. This gives system provenance within the local same-user trust boundary; it does not protect against a hostile root user or a hostile check binary running under the same OS account. Stronger authenticity would require a separate OS identity/sandbox and a signing key inaccessible to check processes.

## Core changes

- Add `artifactId` to `ExecutionEvidence`; the artifact is already available as `manifest.artifactId` before [`recordExecution()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/application/local-orchestrator.ts:809).
- Expand terminal verification evidence with:
  `verificationId`, `artifactId`, `reportSha256`, `planRevision`, and `state: passed | failed`.
- Core must validate all bindings against the current execution result.
- Separate `recordVerificationResult()` from `waiveVerification()`. The former accepts only trusted verifier evidence; the latter requires the Owner actor and reason.
- Remove `unknown` as an externally recordable terminal verification state.
- Preserve the existing rule that approval is impossible unless verification passed or was explicitly waived at [`Lifecycle.review()`](/Users/cuifengshan/Desktop/AI-Workforce-OS/src/core/lifecycle.ts:153).

## Exact file plan

New isolated files:

- `src/core/verification-model.ts` — states, evidence DTOs, pure transition guards.
- `src/storage/verification-jobs.ts` — explicit schema, repository, scoped receipts, audits and claims.
- `src/application/verification-commands.ts` — Owner enqueue/cancel/waive commands.
- `src/application/verification-coordinator.ts` — claim, detached launch, event reconciliation and conditional Core application.
- `src/application/control-plane-orchestrator.ts` — composes current task orchestration and verification coordination.
- `src/verification/protocol.ts` — versioned request/state/event/report contracts.
- `src/verification/worker.ts` — detached worker and authenticated stop handling.
- `src/verification/runner-client.ts` — exclusive start, observe-only resume, events/status/stop.
- `src/verification/check-engine.ts` — hardened artifact copy/check execution extracted from `local-checks.ts`.
- `src/application/verification-queries.ts` — Owner/workspace-scoped job projections.

Existing integration files:

- `src/core/lifecycle-model.ts`, `src/core/lifecycle.ts`, `src/core/engine.ts`
- `src/application/local-orchestrator.ts` for `artifactId` evidence only
- `src/storage/application-store.ts` for explicit schema initialization
- `src/cli/controller-commands.ts` to compose the verification coordinator
- `src/cli/task-commands.ts` to enqueue instead of synchronously verifying
- `src/config/settings.ts` for trusted versioned verification plans

Concurrent transport-owned files should receive only a defined handoff, not overlapping implementation work:

- `POST /api/v1/tasks/:ticketId/verifications` → `202`, never awaits checks
- `GET /api/v1/verifications/:verificationId`
- `POST /api/v1/verifications/:verificationId/cancel`
- optionally `GET /api/v1/tasks/:ticketId/verifications`

Employee and project repositories need no verification-specific changes.

## Required tests

- Core: full transition table; wrong execution/artifact/report rejected; stale Task version produces `SUPERSEDED`; waiver requires Owner; approval remains gated.
- Repository: explicit initialization only, rollback, scoped idempotency conflicts, active-job uniqueness, sequence fencing, terminal immutability, expired claim → `UNKNOWN`.
- Commands: foreign Owner masked as not found, workspace scope, stale version, wrong artifact triple, plan revision mismatch, duplicate/replayed requests and concurrent enqueue.
- Worker: pass, check failure, timeout, output limit, descendant escape, authenticated cancellation, startup failure, forced worker death, stream-close failure, artifact tampering, symlinks, report tampering and directory durability.
- Recovery crash windows: before claim, after claim/before directory, after directory/before spawn, after spawn/before receipt, after terminal report/before DB apply. Assert the spawn marker occurs at most once.
- API: request returns `202` while a long check continues; closing the HTTP connection does not cancel it; controller/API restart resumes observation without respawn; polling exposes state; cancellation requires Owner and job version.
- End-to-end: execution reaches `REVIEW`, Web enqueues verification, detached worker completes, Task evidence is atomically applied, Owner review advances to `DONE`.

After implementation, run focused verification/worker/Core tests first, then the repository’s required `pnpm check`.
