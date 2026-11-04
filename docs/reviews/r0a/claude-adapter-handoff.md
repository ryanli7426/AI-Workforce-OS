# Cursor Claude Code adapter handoff

工具：本机 Cursor Agent；显式 --model auto。这是实施者报告，不代替父 Agent 验收。

I'll read the task doc, AGENTS.md, and the LaunchSpec protocol, then implement only the Claude Runtime adapter files assigned to this round.Found prior Claude executor code and a sibling worktree — I'll use those for protocol details while keeping ownership limited to the assigned files.Implementing the adapter and its pure contract tests next.The failure is from the prompt mentioning “Bash”; I’ll tighten the test to assert argv flags only.Claude Runtime adapter (pi) is in place as a pure argv/result adapter — no spawn, SDK, installs, commits, or live model calls.

### Changed files
- `src/runtime/claude-code.ts`
- `tests/claude-adapter.spec.ts`

### Behavior
- `ClaudeCodeAdapter` (`runtime='claude-code'`) with declarative capabilities: no active input / continue / reattach / pause; `structuredResult: true`
- `createLaunch` → absolute `LaunchSpec` via shared `validateLaunchSpec` / `assertExecutionId`
- Fixed argv: `--print --output-format json --permission-mode default|plan --tools Read,Edit,Write --setting-sources user --strict-mcp-config --mcp-config {"mcpServers":{}}` + scoped untrusted prompt
- `parseResult` requires `type=result`, `subtype=success`, `is_error=false`, `exitCode===0`, and no signal/reason for success; errors/timeouts/malformed/multi-result fail safely with scrubbed bounded summaries
- Usage maps optional finite nonnegative token fields only (missing stay `undefined`)

### Actual tests
```text
pnpm exec vitest run tests/claude-adapter.spec.ts
 Test Files  1 passed (1)
      Tests  11 passed (11)

pnpm exec tsc --noEmit -p tsconfig.test.json
(exit 0)
```

**Limitation:** these mock/parser tests are not live Claude Runtime validation. Parent reviews and does live verification.
