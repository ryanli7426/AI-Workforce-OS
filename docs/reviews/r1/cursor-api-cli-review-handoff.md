# Cursor Auto implementation report

Implementation report; parent integration/gates are the acceptance source.

I'll inspect the owned API CLI files and how `runApiCommand` is routed, then apply the review corrections only there.Implementing signal registration before listen, bounded force-close, safer parser errors, and `http://` address output; then updating the tests.Cleaning up `closeApiServer` and rewriting the acceptance tests.Review corrections are in the two owned files only.

### Changes
1. **Acceptance** — `tests/api-cli.spec.ts` spawns absolute `dist/cli/index.js` from an unrelated cwd (no launcher wrapper / source-grep).
2. **Signals** — `SIGINT`/`SIGTERM` registered before `await app.listen`; stop during/after startup still runs `finally` cleanup (no default Node exit with open DB).
3. **Shutdown** — bounded `app.close` (`CLOSE_GRACE_MS=1500`), then `server.closeAllConnections()` (Node 22), await close before `store.close`, clear timer + listeners. New partial-body TCP + SIGTERM test asserts bounded exit and unchanged DB snapshot.
4. **Parser secrecy** — unknown/unexpected argv use static labels; all stderr paths scrub bare 64-hex tokens.
5. **Address** — listening summary prefers `http://127.0.0.1:<boundPort>`; tests parse the real bound port from that payload.

### Verification
- `pnpm typecheck` — pass
- `pnpm build` — pass (picks up parent `runApiCommand` routing in `dist/cli/index.js`)
- `pnpm exec vitest run tests/api-cli.spec.ts` — **8/8 passed** (2.36s)
