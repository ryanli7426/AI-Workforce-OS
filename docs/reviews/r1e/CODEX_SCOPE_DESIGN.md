> Independent review input; findings and proposed policies require parent disposition. This is not a claim that containment was delivered.

## Verdict

Current `claude 2.1.181` must be considered **not containment-capable** for this Runtime. It should fail closed before launch. The repository currently limits the visible tools to `Read,Edit,Write`, but the Runner executes Claude directly with no OS filesystem boundary.

Key evidence:

- The adapter supplies only prompt guidance, tool selection, user settings, and empty MCP configuration: [claude-code.ts](../../../src/runtime/claude-code.ts#L207).
- `--allowedTools` affects approval; `--tools` is the actual tool-availability cap. Neither confines filesystem paths.
- `LaunchSpec` has no containment requirement or evidence: [protocol.ts](../../../src/runner/protocol.ts#L4).
- Runner directly calls `spawn(spec.command, spec.args, ...)`: [worker.ts](../../../src/runner/worker.ts#L284).
- The environment deliberately exposes `HOME`, `TMPDIR`, and Runtime credentials to the child: [worker.ts](../../../src/runner/worker.ts#L119).
- Worktree ownership validation is good—canonical path, registration, repository identity, branch and marker checks—but it establishes identity, not process confinement: [git-worktrees.ts](../../../src/workspaces/git-worktrees.ts#L326).

## Prioritized design

### P0 — Gate unsupported Claude versions

Require Claude Code `>= 2.1.314` for this policy:

- `permissions.blockReadsOutsideWorkingDirectories` requires `2.1.257`.
- `permissions.blockWritesOutsideWorkingDirectories` requires `2.1.314`.

These settings make built-in file tools reject outside paths across permission modes and handle resolved symlink paths. The installed `2.1.181` predates both, so unknown settings could be ignored in `--print` mode; argv presence is not evidence. [Claude permissions documentation](https://code.claude.com/docs/en/permissions), [settings/version requirements](https://code.claude.com/docs/en/settings).

No fallback to prompt instructions, path deny globs, or hooks is acceptable.

### P0 — Put the entire Claude process behind an OS sandbox

Use a pinned, explicitly configured `@anthropic-ai/sandbox-runtime` (`srt`) as the Runner-owned launcher. Anthropic documents this as whole-process isolation covering built-in file tools, hooks, MCP servers, and descendants. The built-in Claude sandbox covers only shell/Monitor commands; Read/Edit/Write and hooks run outside it. [Sandbox environment comparison](https://code.claude.com/docs/en/sandbox-environments), [sandbox scope](https://code.claude.com/docs/en/sandboxing).

Per execution, generate a private, immutable profile with:

- Read deny over the user-data tree, re-allowing only:
  - the exact canonical execution worktree;
  - required system executables/libraries;
  - a dedicated Runner-owned Runtime temp directory;
  - the documented Claude authentication/config paths.
- Writes denied by default, allowing only:
  - the exact worktree;
  - the dedicated Runtime temp directory;
  - only authentication state that OAuth refresh demonstrably requires.
- Network allowlist limited to `api.anthropic.com`, `claude.ai`, and `platform.claude.com`.
- No local binding, Apple Events, broad Unix sockets, or unsandboxed fallback.
- No raw-Claude fallback if SRT is missing, invalid, incompatible, or fails its probe.

SRT is a beta research preview, so pin its version and treat schema/version changes as capability changes requiring revalidation. [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime).

### P0 — Harden Claude’s own tool layer

After upgrading, add an inline `--settings` policy containing at least:

- `permissions.blockReadsOutsideWorkingDirectories: true`
- `permissions.blockWritesOutsideWorkingDirectories: true`
- `disableAllHooks: true`
- disable bypass/auto permission modes
- explicit Read/Edit denies for the authentication/config and Runtime-temp exceptions permitted to the OS sandbox

Recommended launch additions:

- `--safe-mode`
- `--setting-sources user`
- `--settings <runtime-owned policy>`
- `--tools Read,Edit,Write`
- `--disable-slash-commands`
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`
- `--no-chrome`
- `--no-session-persistence`

Keep `--allowedTools Read,Edit,Write` only if unattended edits are intended; it is approval policy, not containment.

### P1 — OAuth and user-settings compatibility

Do not use `--bare`: local `2.1.181 --help` states that bare mode never reads OAuth/keychain credentials and accepts only `ANTHROPIC_API_KEY` or an explicitly configured helper.

`--restricted` is also unsuitable for this contract: newer documentation says it confines file tools but intentionally does not read user/project settings.

`--safe-mode --setting-sources user` is the compatible compromise:

- OAuth/keychain authentication remains available.
- User model and permission settings remain usable.
- Hooks, plugins, MCP, LSP, status-line helpers, skills and similar customizations are intentionally disabled.
- Runtime inline restrictions have higher precedence than ordinary user settings.
- User `additionalDirectories` cannot widen the OS sandbox.

OAuth creates an unavoidable bootstrap exception: the trusted Claude process must reach its authentication state and OAuth endpoints. The OS sandbox cannot distinguish Claude’s internal credential reads from a compromised Claude process reading the same files. Claude’s file-tool block and explicit permission denies prevent model-issued Read/Edit calls, but a strict “nothing outside worktree, even for the trusted Runtime binary” boundary is incompatible with host OAuth. That stronger requirement needs a separate container/VM or credential broker.

If OAuth requires an unverified helper, socket, configuration path, or broader home access, fail closed rather than widening the profile.

### P1 — Bind authorization to worktree identity

Extend worktree inspection to return a boundary identity containing canonical path plus device/inode. Revalidate immediately before probe and spawn. Do not authorize the worktree root or repository—only the individual execution worktree.

The existing worktree checks are a strong foundation, especially exact path and symlink rejection at [git-worktrees.ts](../../../src/workspaces/git-worktrees.ts#L329), but that identity is not currently preserved into Runner launch.

## Bounded actual negative probe

Run this before every contained launch, using the exact SRT binary and generated profile. It must be a fixed local probe executable with direct filesystem syscalls—no shell, model, network, Claude invocation, or user-file access.

Create a private Runner-owned temporary layout with five files/directories, each at most 1 KiB:

| Probe | Required result |
|---|---|
| Inside positive control | Read, overwrite, and create under the allowed directory succeed |
| Outside read | Reading an owned outside sentinel fails without returning contents |
| Outside write | Overwriting/truncating an owned outside file fails; parent verifies bytes unchanged |
| Outside create | Creating a new outside file fails; parent verifies absence |
| Sibling | Read/write/create in a sibling of the allowed directory all fail |
| Symlink | In-worktree symlinks to outside file and directory cannot read, overwrite, or create through the target |

Also run one outside attempt from a spawned child to prove the boundary covers descendants. Bound the probe to a short timeout, no retries, and fixed output. Accept only expected denial codes such as `EACCES`, `EPERM`, or an intentionally hidden `ENOENT`; unexpected success, timeout, signal, malformed result, or partial mutation fails the launch.

The parent Runner verifies sentinels after the sandbox exits and records the pinned SRT version, profile digest, platform, worktree identity, and probe result in Runner evidence.

## Source interfaces requiring change

- [protocol.ts](../../../src/runner/protocol.ts#L4): add a versioned declarative `ContainmentRequirement`; bump the private request protocol. Do not put credentials or arbitrary wrapper argv in it.
- [runner/client.ts](../../../src/runner/client.ts#L33): accept trusted containment-provider configuration, create the private profile/temp area, and bind the request to policy/profile identity.
- [worker.ts](../../../src/runner/worker.ts#L162): require containment, run the negative probe, wrap the Runtime process, and emit containment evidence. A required policy must make the existing raw spawn path unreachable.
- [environment.ts](../../../src/runner/environment.ts#L1): add only Runner-owned temp variables such as `CLAUDE_CODE_TMPDIR`; continue rejecting caller-supplied SRT or sandbox-control variables.
- [claude-code.ts](../../../src/runtime/claude-code.ts#L183): add version-gated safe-mode/tool-policy argv. The adapter may require containment but must not claim that argv itself provides OS isolation.
- [git-worktrees.ts](../../../src/workspaces/git-worktrees.ts#L19): return a launch boundary identity, or expose a dedicated inspection result for Runner consumption.
- The application launch handoff at [local-orchestrator.ts](../../../src/application/local-orchestrator.ts#L535) must carry that verified boundary into `RunnerClient.start`.

No `src/core` changes are appropriate. Containment belongs to Runtime/Runner/application adapters. I did not review or make recommendations about the parallel Runtime registry implementation.

Finally, this design does not claim protection from an arbitrary malicious process already running as the same host user. Hooks are trusted in-process policy checks, not an OS boundary. Even SRT constrains its child process tree, not unrelated same-user processes; defending against those requires a separate OS identity, container, VM, or device-level enforcement. No files were edited.
