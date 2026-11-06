Resolved. No remaining high- or medium-severity defects found in the specified corrections.

- Runtime fingerprints bind driver ID, protocol version, and capabilities: [registry.ts](../../../src/runtime/registry.ts#L45).
- New executions persist and validate `runtimeRevision`: [repository.ts](../../../src/execution/repository.ts#L58), [local-orchestrator.ts](../../../src/application/local-orchestrator.ts#L582).
- Recovery rejects mismatched identities before reading logs or invoking the parser. Missing identity is accepted only for legacy `claude-code` records through the fixed fingerprint: [local-orchestrator.ts](../../../src/application/local-orchestrator.ts#L715).
- Tests cover same-ID protocol v2, capability changes, and legacy missing identity: [local-orchestrator.spec.ts](../../../tests/local-orchestrator.spec.ts#L281).
- `runtimes` returns after private-directory/settings validation without opening the database: [task-commands.ts](../../../src/cli/task-commands.ts#L723). Settings-only and corrupt-database cases are covered: [task-cli.spec.ts](../../../tests/task-cli.spec.ts#L634).

No tests were run, as requested.
