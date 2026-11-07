## Audit result

The plan is viable without Core changes, but it must be a dual-version protocol rather than adding fields in place.

Key findings:

- Runner currently persists a private immutable request, then directly spawns the target with `shell:false`; there is no containment phase ([worker.ts](../../../src/runner/worker.ts#L261), [worker.ts](../../../src/runner/worker.ts#L284)).
- Pre-spawn work currently has no heartbeat, stop polling, or timeout handling. Those begin only after `RUNNING`, so a containment probe added immediately before the spawn would become stale and effectively uncancellable ([worker.ts](../../../src/runner/worker.ts#L371)).
- `RunnerRequest`, snapshots, and events are fixed at version 1. `LaunchSpec`, cloning, and replay equality all use strict known fields ([protocol.ts](../../../src/runner/protocol.ts#L4), [client.ts](../../../src/runner/client.ts#L212)).
- `ExecutionService.start()` currently converts every start/handshake error to `UNKNOWN`. Deterministic containment rejection must instead become durable pre-target `FAILED` evidence; only uncertain ownership/evidence should become `UNKNOWN` ([execution-service.ts](../../../src/application/execution-service.ts#L43)).
- Settings are strict and version 1. An optional containment setting can preserve old files, provided absence always means disabled ([settings.ts](../../../src/config/settings.ts#L46)).
- `@anthropic-ai/sandbox-runtime` is already pinned exactly at `0.0.81`, despite the older design document saying it was not installed ([package.json](../../../package.json#L43)). It remains a beta provider.
- The generic verification wrapper has its own hand-written stable LaunchSpec serializer. Adding containment without updating or centralizing that serializer would let containment differences escape its immutable-request comparison ([client.ts](../../../src/verification/client.ts#L294)).
- One composition-only change in `local-orchestrator.ts` is unavoidable to carry validated settings into `ExecutionService` or `RunnerClient`; otherwise settings cannot activate the feature ([local-orchestrator.ts](../../../src/application/local-orchestrator.ts#L298)).

## Recommended contract

Use:

```ts
interface ContainmentRequirementV1 {
  version: 1
  mode: 'required'
  provider: 'srt'
  providerVersion: '0.0.81'
  policyId: 'darwin-worktree-fs-v1'
  boundary: {
    canonicalRoot: string // must equal cwd
    device: string        // decimal stat identity
    inode: string
  }
  probeVersion: 1
  preflightTimeoutMs: number
}
```

`LaunchSpec.containment` is optional at the TypeScript level, but protocol encoding is discriminated:

- Request v1: containment must be absent; snapshots/events remain exactly legacy v1.
- Request v2: containment must be present and `mode: required`; snapshots/events are v2.
- Never emit v2 for an uncontained request.
- Never reinterpret a stored v1 request using current settings.

For replay, if a contained start reaches an existing v1 execution directory, compare all legacy fields after removing only the new containment field. If they match, observe the stored v1 request and report it as uncontained; do not rewrite, respawn, conflict, or mark it `UNKNOWN`. Any other difference remains a hard conflict.

Persist an immutable `containment.json` before target spawn, mode 0600 and directory-fsynced, containing:

- SHA-256 of the exact stored `request.json`;
- runner identity;
- provider/package version and platform;
- resolved boundary device/inode;
- digest of the generated SRT policy/config;
- fixed probe version and bounded result flags;
- probe timestamps and evidence digest.

Do not call the config digest an internal Seatbelt-profile digest unless SRT actually exposes the generated profile. Client validation must require matching request hash, runner identity, boundary identity, and evidence digest before accepting a v2 `RUNNING` or any terminal state containing a target `processId`.

## Worker lifecycle

For v2, the raw spawn branch must be unreachable:

1. Emit `STARTING` immediately.
2. Heartbeat and poll authenticated stop requests throughout setup/probing.
3. Revalidate canonical cwd plus device/inode.
4. Run a credential-free fixed Node probe through the exact pinned SRT provider/config. It must exercise direct and descendant read/write/create denials and verify sentinels from the worker.
5. Persist verified evidence.
6. Recheck stop and boundary identity.
7. Spawn the actual target only through SRT.

The documented pinned `srt` CLI, invoked through Node with argv and `shell:false`, is preferable here to direct `sandbox-exec`: its probe/target wrapper can be placed in a dedicated process group and reliably terminated on cancel or timeout. Never pass `RUNTIME_ENV_CHANNEL` to SRT or the target; the existing sanitized runtime environment must remain the only target environment.

Lifecycle outcomes:

- Unsupported provider, dependency failure, negative-probe success where denial was expected, or confirmed preflight timeout: `FAILED` before target spawn.
- Cancel before target spawn: with the current execution repository contract, emit pre-target `FAILED` with a stable `cancelled_before_target_spawn` reason; Core already resolves a pending task cancellation after confirmed stop. Emitting processless `CANCELLED` would require an out-of-scope execution transition change.
- Probe tree, cleanup, target spawn, or durable evidence whose termination/persistence cannot be confirmed: `UNKNOWN`; retain assignment and occupancy.
- Target timeout starts only after target wrapper spawn. Preflight uses its own short timeout.
- Once the target wrapper is spawned, retain the existing process-group `STOPPING`/SIGTERM/SIGKILL confirmation semantics.

Keep Claude’s registered `filesystemIsolation` capability false. Runner-level proof establishes that a specific request used a tested boundary; it does not prove Claude authentication, model selection, configuration loading, or valid worktree editing. Those require the separate real auth/model pilot before any Claude capability claim.

No files were changed, and no tests, probes, models, services, or credential inspections were run.
