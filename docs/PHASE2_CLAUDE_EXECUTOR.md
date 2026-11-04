# Phase 2: Claude Code Executor

> 迁移背景：本文记录旧 dsh-superagent-prototype 工作区的状态与命令。新项目可用能力以 [B0 交付记录](BOOTSTRAP.md) 为准。

Status: implementation milestone complete with a mock CLI. Live model execution and Claude stream protocol interoperability remain unverified.

## Implemented

- Runtime independent `AgentExecutor` contracts in `src/executor/base.ts`.
- Claude Code process launch in `src/executor/claude-code.ts`: non-interactive print invocation, JSON stream input/output, per execution session ID, configured timeout, bounded stdout, captured stderr, exit status, usage fields when present, and structured terminal result validation.
- Git Worktree ownership and path validation in `src/executor/worktrees.ts`; one worktree per Ticket and Assignment marker. Dirty removal requires explicit approval and uses Git's worktree removal command.
- Process start returns its handle after spawn and metadata persistence; a background monitor collects process completion. Stop sends termination to the process group and escalates to kill.
- Result evidence includes the base Git commit plus a SHA-256 fingerprint of tracked diff and untracked file contents. This is an evidence fingerprint, not a commit and not CI evidence.
- `deliver()` and parent-process `resume()` return/throw explicit unsupported results. No claim of live input or restart attachment is made.
- No bypass permission mode is enabled. `ANTHROPIC_API_KEY` is removed from the child environment; the CLI may use its own local authentication mechanism. Logs and saved summaries pass through basic credential pattern redaction.

## CLI inspection and verification boundary

The local Claude Code CLI reported version `2.1.181`; its help advertised print mode, stream JSON, session IDs, resume, output formats, and permission modes. The repository integration test uses `tests/fixtures/claude-cli.mjs`, which emulates the expected stream protocol. It validates LAO lifecycle behavior only. It does not verify the actual stdin envelope, result schema, authentication behavior, tool permissions, or model execution against the installed CLI.

No live model task was started. A live call requires explicit confirmation of expected local Claude Code usage and cost, then a small controlled smoke task. Until that run is approved and recorded, Phase 2 is not accepted as an end-to-end Claude runtime validation.

## Known limits and follow-up

- `resume()` cannot reconnect a monitor after LAO parent restart. A durable child supervisor or independently attachable runner is needed before recovery acceptance.
- Active `deliver()` is unsupported because this implementation runs one print-mode request and has not established a supported interactive continuation protocol.
- The permission mode defaults to Claude's `default` mode and does not grant the dangerous bypass mode. Tool allowlists can be provided through executor configuration; policy enforcement for Git push, merge, publish, and destructive operations still needs integration with the application approval flow.
- Credential scrubbing uses patterns and cannot guarantee removal of every secret format from arbitrary model output. Child environment is kept minimal and the API key variable is excluded.
- Timeout and output-limit behavior rely on terminating the CLI process group; platform-specific behavior still needs validation on supported operating systems.
- The executor does not decide Ticket state. It reports execution evidence; Core/Application must separately decide review, verification, approval, and completion.

## Verification

- `pnpm check:executor`: standalone Core plus executor typecheck, mock executor integration tests, and standalone build.
- Mock integration covers worktree isolation, successful structured output, non-success despite a zero exit code when the terminal result reports an error, marker/path rejection, and explicit unsupported delivery/recovery.

Real Claude execution, CI verification, restart recovery and DingTalk integration are not part of this phase's completed checks.
