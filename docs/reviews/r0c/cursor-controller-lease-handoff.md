# Cursor Auto controller-lease

Implementation report only. Parent corrections and integrated gates determine acceptance.

I'll read the operations task section and AGENTS.md first, then inspect the two owned files before implementing.No lease module yet — I'll study the path/permission helpers and similar ownership patterns next.I have enough of the security and lock patterns to implement the lease module and its tests next.Next I'll add the spec covering live-owner refusal, dead-owner recovery, fencing, and the other required cases.The missing-dir path was leaking raw ENOENT from symlink checks — I'll map that to a clear fail-closed error.Removing the unused `readFileSync` import.Implemented the controller-lease slice in exactly the two owned files.

### Delivered
- `src/application/controller-lease.ts` — `acquireControllerLease`, `inspectController`, `requestControllerStop`, lease `shouldStop`/`release`
- `tests/controller-lease.spec.ts` — 14 tests (live-owner child refusal, dead-owner recovery, replacement fencing, malformed/missing metadata, recovery-claim intervention, 0700/0600, symlink rejection, stop token mismatch, no root creation)

### Behavior
- Exclusive private `controller.lock/` + `owner.json` (`version`, `pid`, 64-hex token, `startedAt`)
- Authenticated `stop.json` only (no PID signals); token never returned in inspect/status/errors
- Live/`EPERM` preserves lock; missing/corrupt owner → `unknown` and blocks acquire/stop
- Dead-owner recovery uses exclusive in-lock `recovery.claim`, revalidates identity/liveness, quarantines, then writes new owner; crashed claim fails closed
- Release deletes only matching lock/owner/stop identities

### Gates
| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `vitest run tests/controller-lease.spec.ts` | 14/14 pass |
| Other files / install / commit / push | untouched |

### Limitations
- Not wired into CLI/daemon (parent integration)
- `EPERM` liveness covered in code paths; hard to fixture under same-uid tests
- Uncertain mid-recovery leftovers need explicit manual cleanup by design
- No production background-service claim
