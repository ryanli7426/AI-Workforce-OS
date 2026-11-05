# Cursor Web initial handoff (superseded by review)

Agent self-report; final parent gates are authoritative.

I'll read AGENTS.md, product UX, verification routes, and existing web API/page patterns before implementing only the four owned files.Implementing the verification API client and TaskVerification page next, matching the routes contract and existing confirmation/idempotency patterns.Implementing the verification API client and TaskImplementing the verification API client and TaskVerification page from the HTTP contract and existing web patterns.Fixing preview state so confirmation UI re-renders reliably, then writing the tests.Updating specs to match existing assertion style without jest-dom matchers.Fixing async throws, HTML5 validation blocking preview, error messaging, and the flaky poll test.Owned only the four web files. `pnpm web:typecheck` and 12 targeted vitests passed.

### Delivered
- **`web/src/verification-api.ts`** — HTTP client for verification-routes (`plans` / `list` / `get` / `create` 202 / `cancel` 202), strict DTO decoders, no core imports.
- **`web/src/pages/task-verification.tsx`** — REVIEW enqueue UI: plan select, reason, exact binding preview, frozen binding across parent poll, stable idempotency key, 409 reconfirm, 1s active history poll, applied/superseded/unknown, cancel intent (not success), empty-plan CLI guidance, stale/non-REVIEW disabled. No waiver / no UI-passed state.

### Parent handoff
`createApiClient` keeps `request` private. Wire with:

```ts
createVerificationApi({ request }) // once exported from shared authenticated client
// or equivalent same-token transport
```

Pass `<TaskVerification api={verificationApi} ticket={ticket} />`. Do not mint a second token from storage/URL or ship fake production fixtures. Parent integration & browser E2E later.
