# Cursor Auto controller-cli-review

Implementation report only. Parent corrections and integrated gates determine acceptance.

I'll inspect the controller CLI ownership and the two files under review, then apply only the listed fixes.I have enough context: fixing only the two owned files—event append/rotation safety, release failure reporting, and stop-channel auth—then adding regressions and running gates.Applying the event-file, stop-channel, and cleanup fixes in `controller-commands.ts`.Tightening the create-path race: reject an unsafe pre-existing opened file instead of fixing it with `fchmod`.Adding regression tests for stop-token mismatch, ownership loss, and release failure.Lease module arrived from parent; `execution-logs` is still missing. Running the remaining gates and checking for that module.Review fixes are in the two owned files only (`src/cli/controller-commands.ts`, `tests/controller-cli.spec.ts`).

**Fixes**
1. **Events:** `fchmodSync(fd)` only; reject unsafe/replaced existing files; verify opened identity vs observed; `writeAll` loop; rotations validate all first and compare inode identity; no foreign deletes.
2. **Cleanup:** timers/listeners/DB always cleared; success JSON only after cleanup; `lease.release` failure → nonzero; original loop error preserved when both fail.
3. **Stop channel:** removed `stopEvidencePresent` abort; `shouldStop` owns auth (mismatch → continue); throws → `malformed-stop` / `lease-loss` → nonzero.
4. **Tests:** mismatched stop ignored; in-place owner token replacement; lock replacement/release failure; malformed stop → no success summary.

**Gates (actual)**
- `pnpm check` → **FAIL** at `pnpm typecheck`
- `TS2307`: cannot find `../observability/execution-logs.ts` (from `controller-commands.ts:31`)
- `vitest run tests/controller-cli.spec.ts` → suite fails on the same missing import (0 tests run)
- Present: `control-loop.ts`, `controller-lease.ts`
- Still missing (no substitute added): `src/observability/execution-logs.ts`
- Untouched: `index.ts` routing, no install/commit/push
