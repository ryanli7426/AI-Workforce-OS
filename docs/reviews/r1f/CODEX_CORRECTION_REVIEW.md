No remaining high- or medium-severity defect was found in the reviewed corrections. All three original findings are resolved by static review.

- High — implicit shared writable SRT paths: resolved. The pinned package’s default write paths are converted to explicit `denyWrite` entries, excluding only stdout/stderr/null; effective read/write configuration is included in the policy hash; and the inner command receives private `TMPDIR`/`TMP`/`TEMP` overrides. See [srt.ts](../../../src/containment/srt.ts#L90) and the package defaults in [sandbox-utils.js](../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js#L500).

- High — Runner root overlapping `cwd`: resolved. Both the client and independently invoked worker reject equality or containment in either direction against the entire canonical Runner root. See [client.ts](../../../src/runner/client.ts#L68) and [worker.ts](../../../src/runner/worker.ts#L279).

- Medium — local/private network access through `allowedDomains`: resolved. Validation rejects IP literals, single-label names, and local/special suffixes; the SRT policy additionally denies loopback, private, CGNAT, link-local, multicast, ULA, and related IPv6 classes after DNS resolution. See [policy.ts](../../../src/containment/policy.ts#L34) and [srt.ts](../../../src/containment/srt.ts#L96).

The new tests are genuine regression tests:

- The `/private/tmp/claude` case uses an owned randomized subdirectory and verifies denial of both sentinel overwrite and new-file creation while preserving writes inside `cwd`: [contained-runner.spec.ts](../../../tests/contained-runner.spec.ts#L75).
- The nested-root case first verifies client rejection, then bypasses the client by directly launching the worker with a v2 request and confirms the target never launches: [contained-runner.spec.ts](../../../tests/contained-runner.spec.ts#L92).

Cleanup now waits for in-flight initialization before reset, while unconfirmed reset/probe-group termination retains uncertainty rather than supplying success evidence: [srt.ts](../../../src/containment/srt.ts#L74).

No remaining high/medium reproduction applies. Tests were not run, as requested. The native Claude `--version` SIGTRAP remains only a recorded failure; it supplies no containment claim, and product settings/capability remain unchanged.
