# Cursor Runner client handoff

工具：本机 Cursor Agent；首路沿用客户端配置，后续统一 --model auto。这是实施者报告，不代替父 Agent 验收。

I'll implement only the Runner client per the R0A contract—reading the task doc, AGENTS.md, and protocol types first, then touching solely `src/runner/client.ts` and its validation tests.I'll mirror the CLI's private-directory and symlink checks, then implement the client against the protocol types.I have enough contract detail to implement the client and seed-based validation tests next.Cleaning up the path assertion and switching spawn handshake to the `spawn` event, then writing the validation tests.All nine validation tests passed. Running a typecheck next to confirm the new files are clean.Implemented the Runner client only.

### Changed files
- `src/runner/client.ts` — `RunnerClient` with detached spawn/handshake, idempotent `start`, validated `status`/`stop`/`events`
- `tests/runner-client-validation.spec.ts` — seed-file + fixture-worker validation

### Tests run
- `pnpm exec tsc --noEmit -p tsconfig.test.json` — pass
- `pnpm exec vitest run tests/runner-client-validation.spec.ts` — **9/9 pass** (~5.2s)

Covered: unsafe IDs / shared+symlink roots; real handshake (FAILED first state); handshake timeout retains dir + UNKNOWN; idempotent identical start (no respawn) + conflicting spec reject; missing request/state UNKNOWN without spawn; stale/dead → UNKNOWN while terminal remains trusted; symlink owned-file refuse; stop only for live fresh nonterminal (atomic `stop.json`, no signals); events cursor/incomplete-line/malformed/sequence checks.

### Limits
- No real `src/runner/worker.ts` — handshake uses in-test fixture workers; full lifecycle/orphan matrix waits on worker + `tests/runner-integration.spec.ts`
- Default `staleAfterMs` is **2000**; default `workerPath` is sibling compiled `worker.js`
- `pid` liveness is observe-only (never kill/restart); UNKNOWN / conflict / timeout paths leave the execution directory for reconcile
- No install, commit, push, or other files touched
