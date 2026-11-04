# AI Workforce OS repository contract

- This is the independent local control-plane foundation. Product baseline: docs/product; architecture: docs/AI_WORKFORCE_OS_ARCHITECTURE.md. Old Phase documents are migration history, not feature availability.
- src/core owns domain state and transactions; it must not import Runtime, IM, HTTP or storage implementations. src/storage implements repositories. src/cli is an adapter, not a second state machine.
- Agent results are evidence. Verification and authorized review determine DONE. Preserve source identity uniqueness, policy-version checks, stale-assignment rejection, and cancellation/stop confirmation.
- Never spawn, call external CLIs or await network operations inside a repository transaction. Unknown process ownership must retain its assignment until reconciled.
- Do not import @deepseek-ai packages. Keep upstream license and file provenance. Update the migration manifest only when recording an intentional modification; preserve original hashes separately.
- CLI queries must not initialize or migrate storage. Initialization is explicit. Do not pretend the daemon, Runtime or DingTalk connector is operational.
- Delegated Codex tasks must use the user-requested GPT-5.6 family, explicitly gpt-5.6-sol for this milestone. If unavailable, report it; do not silently substitute another model. Keep agents on disjoint files and review before integration.
- Quality gate: pnpm check (typecheck, Vitest, build, isolated smoke, dependency scan). Re-run relevant gates after changes. Do not commit or push without an explicit instruction.
