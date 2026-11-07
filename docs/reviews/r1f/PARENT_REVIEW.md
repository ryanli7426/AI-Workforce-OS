# R1-F parent review disposition

Parent owns production implementation and actual OS/Runner/CLI integration. Local Codex explicitly gpt-5.6-sol supplied design review, implementation review, correction review, and owned only tests/containment-evidence.spec.ts. Reviews are input; main-worktree actual tests and parent corrections determine acceptance.

## Resolved independent findings

- High: srt defaultWritePaths included shared /tmp/claude despite requested allowWrite only cwd. Explicit denyWrite now derives from pinned provider defaults, except stdout/stderr/null; HOME convenience write grants are also revoked. Private TMPDIR alone was insufficient. Digest now includes requested plus initialized effective read/write configuration; real owned shared-temp regression proves outside overwrite/create denial with positive inside write.
- High: nested Runner root exposed HMAC/control files to target. Both RunnerClient and independently invoked Worker enforce canonical roots are disjoint in both directions. Read exceptions protect the entire Runner root, not just current execution; direct Worker regression verifies bypass resistance.
- Medium: allowlisted localhost/IP could use proxy to reach local services even though direct sockets were denied. Validator now requires qualified public names, rejects IP/single-label/local/special suffixes; srt deniedResolvedAddresses explicitly covers private, loopback, CGNAT, linklocal, multicast and IPv6 classes. No wildcard or parentproxy settings are accepted.

Independent correction review found no remaining high/medium issue in its scope. Actual regression tests passed in the main worktree.

## Additional lifecycle and compatibility decisions

- Preserve strict replay conflict when caller adds required to an existing v1 request. The design review proposed observing existing uncontained state, but that could be misread as satisfying required start. Explicit conflict prevents downgrade and never respawns/upgrades old requests.
- New request/snapshot/event v2 is discriminated from legacy v1. Stop requests retain original authenticated v1 channel. Canonical serialization is shared with verification to prevent missing-policy replay equality.
- The provider initialization promise must settle before reset can be confirmed. Unknown cleanup keeps dedicated session ownership and evidence, not reusable success. Probe process groups are checked; unknown group termination propagates UNKNOWN.
- Parent caught a terminal-ordering gap: provider reset in finally could fail after SUCCEEDED had already been written. Cleanup now precedes all confirmed terminal publication paths; fault-injection test proves actual target exit0 remains UNKNOWN with no SUCCEEDED event if provider cleanup is unconfirmed.
- Fixed raw proxy/Runtime secret redaction, suppressed returned library.env propagation, bound temporary paths inside the OS boundary, and restricted both current and neighboring private control directories.
- Zod 3.25.0 package installed without its declared dist and failed actual module import. pnpm11 ignored package.json overrides; proper pnpm-workspace.yaml pins only srt's Zod to3.25.76. Frozen installation and real import/probes succeed. No lifecycle installation scripts were executed.

## Remaining product boundary

This delivers required Runner machinery and offline fixtures, not finished Claude containment. Actual installed Claude --version failed SIGTRAP even after narrow system-selector and temporary-directory corrections. No model/authentication success was inferred. Driver filesystemIsolation remains false; no automatic application configuration switch, user credential reads, real IM, Git push by a Runtime or production Task acceptance occurred. The project's authorized code push is separate from Agent task policy.

The provider's native OS boundary still assumes a trusted host identity; same UID privileged host tampering is not solved by HMAC or path policy. Beta SRT and explicitly granted read exceptions require deliberate versioned validation. Final gate evidence is in CHECK.json.
