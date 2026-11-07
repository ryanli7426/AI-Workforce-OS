## Findings

1. High — SRT silently grants a shared writable path outside the worktree.

The requested policy only lists `cwd` under `allowWrite` and leaves `denyWrite` empty ([srt.ts](../../../src/containment/srt.ts#L93)). However, pinned SRT prepends its default writable paths ([sandbox-manager.js](../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js#L1498)), including shared `/tmp/claude` and `/private/tmp/claude`, which it says are never removed by read restrictions ([sandbox-utils.js](../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js#L499)).

The new inner `TMPDIR` override correctly points normal temp usage at the private directory, but it does not revoke those implicit write grants. A contained target can explicitly create or overwrite a guessed path under `/tmp/claude`. The negative probe tests random outside/sibling paths, so it still reports `checks:"passed"`, and `policySha256` hashes the requested object rather than SRT’s effective write configuration.

Reproduction: launch v2 with a target that executes `mkdirSync('/tmp/claude',{recursive:true})` followed by `writeFileSync('/tmp/claude/containment-escape','x')`; verify the file exists outside `cwd`.

2. High — v2 does not prevent `cwd` from containing its private Runner control directory.

`RunnerClient.start()` validates `cwd` and creates the execution directory independently, without a disjointness check ([client.ts](../../../src/runner/client.ts#L63)). The worker now correctly rejects `readOnlyPaths` overlapping its execution directory, but does not reject the execution directory itself being below `cwd` ([worker.ts](../../../src/runner/worker.ts#L279)). SRT then grants the target read/write access to the entire `cwd`.

If the client is constructed with `root = join(cwd, '.runners')`, the target can read `request.json`, including the HMAC token, and write/delete `state.json`, `events.jsonl`, `containment.json`, logs, and stop evidence. This defeats the private-file protocol and the HMAC trust boundary ([evidence.ts](../../../src/containment/evidence.ts#L14)) without requiring a separate hostile host process.

Reproduction: place the Runner root under the launch working directory and have the target read `.runners/<executionId>/request.json`. Existing tests always use sibling `work` and `runners` directories, so they do not exercise this case.

3. Medium — `allowedDomains` admits explicit local-address access through SRT’s proxy.

The validator accepts single-label names and IPv4 literals such as `localhost`, `127.0.0.1`, and `169.254.169.254` ([policy.ts](../../../src/containment/policy.ts#L32)). SRT explicitly treats an allowlisted IP literal or `localhost` as authorization to reach that local address and bypasses its resolved-address rejection ([resolved-address-guard.js](../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js#L14)).

`allowLocalBinding:false` still blocks direct `net.connect`, so the existing direct-network test passes; proxy-aware clients can nevertheless reach the allowlisted local service. Reproduction: allow `127.0.0.1`, start a local HTTP listener, and invoke a proxy-aware client such as `curl` from the target.

## Confirmed properties

- Runner v2 has no raw-target fallback: preparation or wrapping failure returns before the common spawn.
- Preflight heartbeat, authenticated stop polling, and the preparation deadline are present.
- `wrapWithSandboxArgv().env` is not forwarded; Runtime secrets use the explicit environment channel, and the SRT proxy token is included in output redaction.
- Filesystem entries use `{literal:true}`.
- Signed evidence binds Runner ID, request version, canonical launch specification, policy evidence, and HMAC; proof reading includes no-follow and stable-file checks.
- Canonical serialization includes containment, so a legacy v1 replay conflicts with a containment upgrade.
- The CLI remains a fixed no-model probe and makes no Claude-containment claim. The registered Claude capability remains `filesystemIsolation:false`.

The findings above are milestone integration defects. Separately, the HMAC/private-file design still assumes a trusted same-UID host: such a host can inspect transient proxy-token argv, modify `0600` Runner files, or replace the worktree in the final identity-check-to-spawn interval. I did not count those preexisting host assumptions as new defects.

No files were edited and no tests, models, agents, business operations, or credential/configuration inspection were performed. I did not rerun the parent’s 10 OS/Runner tests.
