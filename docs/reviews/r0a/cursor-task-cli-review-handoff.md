# Cursor Auto task-cli-review handoff

Implementation report only; parent review and integrated gates determine acceptance.

I'll fix the Task CLI follow-ups in the two owned files. First I'm reading those files and the related interfaces the parent is still updating.I'll mirror the settings symlink/owner hardening pattern and check how create field errors should avoid echoing untrusted keys.I have enough context to implement the fixes. Rewriting both owned files next.Removing the unused helper, then updating the tests.`rejectSymlinkComponents` was leaking raw ENOENT; I'll map missing paths to the existing init/not-found errors.Parent review bugs fixed in the two owned files.

### Fixes
1. **`withLocalStore`** — now `async`, `await`s the operation inside `try`/`finally`; test covers post-await DB use via `withLocalStoreForTests`
2. **`parseCreateInput`** — requires real strings (no `String()`); service still enforces safe ids/nonblank; tests cover null/number/object per field
3. **Path hardening** — ancestor symlink walk (trusted Darwin `/tmp`,`/var` only), owner checks on private dirs/files; FD read capped at 128KiB via `readSync` + `fstat` race check
4. **Skipped tests removed** — fixture/`LocalOrchestrator` used directly
5. **`graceMs`** — `settings.runtime.graceMs` passed into orchestrator runtime object
6. **Unknown keys** — create/check schema errors do not echo untrusted key names
7. **Empty `[]` checks-file** — rejected; waive only via explicit `--waive` + nonblank `--reason`

### Test outcomes
| Gate | Result |
|------|--------|
| `tsc --noEmit -p tsconfig.test.json` | pass |
| `vitest run tests/task-cli.spec.ts` | **15 passed** (0 skipped) |
| `vitest run tests/task-cli.spec.ts tests/cli.spec.ts` | **32 passed** |

No dependency edits, installs, commits, pushes, or real model calls.
