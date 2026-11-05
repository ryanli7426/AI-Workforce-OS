# Cursor engine review

Implementation handoff; parent gates remain authoritative.

I'll start from the task doc and the owned verification files so the ENGINE fixes stay scoped to the review items.Looking at the termination and callback paths next — those are where the unbounded waits and missing `directExited` proofs show up.Implementing the four ENGINE fixes: absolute termination deadline with `directExited` proof, bounded `onProcess` racing, and aggregate 1MiB supervised output budget.I'll apply the production fixes in `local-checks.ts` first, then extend the supervision tests.Updating `verifySupervised` for the aggregate output budget and the new infrastructure-failed path.Running targeted typecheck and the local-checks / supervision suites.Aggregate-output test is hanging past the default 5s — checking whether the budget is applied and whether the second check is stalling.First check used `process.exit(0)` before stdout flushed, so the aggregate budget never shrank. Updating the test to write synchronously.ENGINE review fixes are in `src/verification/local-checks.ts` and `tests/verification-supervision.spec.ts` only.

### Fixes
1. **Termination** — Confirmation now requires `directExited + childClosed + group absent`. Absolute `TERMINATION_BOUND_MS` ends the wait even with no events → `unknown`. Run-loop close proof also requires `directExited`.
2. **onProcess** — Deadline starts at child launch; callback races abort + check deadline; listeners/timers always cleared. Hung callback → stop child → `cancelled` / `CHECK_TIMEOUT` / `unknown` by proof.
3. **Output** — Supervised aggregate budget is 1MiB across checks (legacy still 1MiB/check); remaining bytes passed into `runOwnedCheck`.
4. **Monitor errors** — Still `unknown` even if stop looks confirmed; no synthesized `failed`.

### Tests / types
- `pnpm typecheck` — pass  
- `tests/local-checks.spec.ts` + `tests/verification-supervision.spec.ts` — **24/24 pass**  
- New coverage: missing exit/close mock, hung callback abort/timeout (ENGINE fixes landed in owned files only (`local-checks.ts`, `verification-supervision.spec.ts`).

### Fixes
1. **Termination proof** — Confirmed stop now requires `directExited` + stream `close` + group absence. `TERMINATION_BOUND_MS` caps `awaitOwnedTermination` and the run loop so missing exit/close cannot spin forever → `unknown`.
2. **`onProcess` bound** — Check deadline starts at child launch. Callback races abort + deadline; listeners/timers always cleared. Hung callback → stop child → `cancelled` / `failed:CHECK_TIMEOUT` with proof, else `unknown`.
3. **Aggregate output** — Supervised mode budgets **1MiB total** across checks via `maxOutputBytes`; legacy `verify` stays **1MiB per check**. Overflow fails the check with proof.
4. **Monitor errors** — Unexpected monitor errors still return `unknown` even if stop looks confirmed; no synthesized `failed`.

### Tests / gates
| Gate | Result |
|------|--------|
| `pnpm typecheck` | pass |
| `tests/local-checks.spec.ts` | 9/9 pass |
| `tests/verification-supervision.spec.ts` | 15/15 pass |

New coverage: missing exit/close with absent group; never-resolving callback + abort/timeout (no child leak); two sub-cap checks exceeding the global 1MiB budget.
