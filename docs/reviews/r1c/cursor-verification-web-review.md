# Cursor Web parent-review correction

Agent self-report; final parent gates are authoritative.

I'll fix only the four owned verification web files for the POST create/cancel contract and strict decoders. First I'll locate those files and the shared ID/parser rules.Next I'll confirm the backend command-result shape and any parent-review notes on the strict decoder rules.Checking how similar ISO and exact-key validation is done elsewhere, and reviewing the create-body plan ID rules.Implementing the contract fix and strict decoders across the four owned files.Updating the component next: use `verificationId` from the 202 receipt and invalidate task/tasks/overview when a terminal application appears.Cleaning up the terminal-application observation effect — the prior version was too noisy.Parent-review fixes are in the **4 owned web files only**. `pnpm web:typecheck` and **16/16** targeted vitests passed.

### Critical contract
- POST create/cancel 202 is now `{ verificationId: string, replayed: boolean }` — not `{ job, replayed }`.
- Decoder rejects the invented job shape; transport + UI use the actual ID and refetch list/detail.
- Regression fixture covers the real backend 202 DTO.

### Strict decoders
- Plan/check/revision IDs: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` (dots OK).
- Ticket/verification/execution/artifact/idempotency: no dots.
- Exact allowed/required keys; reject `command`/`args`/`secret`.
- Canonical ISO timestamps, safe owner/workspace IDs, positive PIDs.
- State cross-fields: COMPLETED needs outcome+digest+application+finishedAt; FAILED needs failureCode and forbids outcome/digest/application; active forbids finished/outcome.
- Plan registry ≤64, timeout ≤3600000, unique checks 1..32.

### UI
- Create/cancel invalidate by `commandResult.verificationId`.
- Observing a new applied/superseded application invalidates `['task', ticketId]`, `['tasks']`, `['overview']`.
- Network errors keep frozen binding + idempotency key; 409 forces explicit reconfirm with a new key.

### Parent wire-up
Keep `request` private. Compose:
```ts
client.verification = createVerificationApi({ request })
```
and pass `<TaskVerification api={client.verification} ticket={ticket} />`.
