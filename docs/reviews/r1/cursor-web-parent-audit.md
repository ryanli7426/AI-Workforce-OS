# Cursor Auto independent read-only review

This was a concurrent source snapshot; dispositions and later evidence are in WEB_ACCEPTANCE.md.

I'll start with AGENTS.md, then read the parent-owned Web/API files you listed and verify findings against the actual source.Next I'll verify auth, the API client, Vite/package wiring, and the web-assets tests against the review focus areas.Re-reading `app.tsx` and Vite config — Grep and the earlier read disagreed on the login button markup.Checking a few more concrete mismatches between the e2e assertions and the served UI, and confirming the Vite/dev Origin path.## Findings (severity order)

### 1. High — `web:dev` proxy is incompatible with default Origin allowlist
**Where:** `web/vite.config.ts:5` + `src/cli/api-commands.ts:301–307` + `src/api/server.ts:480–481` / `src/api/auth.ts:518–536`

Vite proxies `/api` from `127.0.0.1:5173` → `4310` with `changeOrigin: false`. Default allowlist is only:

```301:307:src/cli/api-commands.ts
function defaultAllowedOrigins(port: number): readonly string[] {
  if (port === 0) return Object.freeze([])
  return Object.freeze([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ])
}
```

Verified: `Origin: http://127.0.0.1:5173` is **DENIED** against that allowlist (`FORBIDDEN_ORIGIN`). Same-origin `fetch('/api/v1/...')` from the Vite app sends that Origin, so login/`me` fails under the advertised `web:dev` + default `api-serve` pairing. Production `--web-root` same-origin serving is fine; this breaks the Vite path.

**Remedy:** Make the proxy path work (e.g. document/require `api-serve --allow-origin http://127.0.0.1:5173`, or teach the CLI/dev script to pass it), or remove/repurpose the proxy so it cannot imply a working default.

---

### 2. High — E2E clicks a button name the UI does not expose
**Where:** `web/e2e/owner-flow.spec.ts:78` vs actual control in `web/src/pages/tasks.tsx:811`

```78:78:web/e2e/owner-flow.spec.ts
  await page.getByRole('button',{name:'批准执行',exact:true}).click()
```

The visible/accessible control is **`批准`**. `"批准执行"` is only the draft/preview label via `actionLabel()` (`tasks.tsx:144`), not the button’s accessible name. With `exact: true` this step cannot match the approve control, so the claimed browser approval/cancel persistence path does not assert what it claims (and fails if run against current UI).

**Remedy:** Assert `getByRole('button', { name: '批准', exact: true })` (and keep preview copy separate), then re-run `web:e2e`.

---

### 3. Medium — `--port 0` + Web UI: empty Origin allowlist after bind
**Where:** `src/cli/api-commands.ts:301–302`, `309–321`, `395`, `418–429`

Allowlist is computed from the **requested** port before `listen`. For `--port 0`, `defaultAllowedOrigins(0)` returns `[]`. After bind the real port is e.g. `54321`, but allowlist stays empty, so any browser `Origin` fails while document navigations without Origin can still load public HTML. CLI clients with no Origin still work.

**Remedy:** After `listen`, rebuild allowlist from the bound `AddressInfo.port` (unless `--allow-origin` was set), or reject `--port 0` when `--web-root` is set / when browser Origins are expected.

---

### 4. Medium — Vite `root: 'web'` is cwd-relative and breaks when cwd is `web/`
**Where:** `web/vite.config.ts:4`

Config lives under `web/`, but `root: 'web'`. From repo root, Vite resolves root to `…/web` (works with `pnpm web:build`). From `web/` cwd, it resolves to `…/web/web` (verified).

**Remedy:** Set `root: '.'` (config already in `web/`), or otherwise make root independent of invocation cwd.

---

### 5. Medium — Browser e2e under-asserts the security boundaries it names
**Where:** `web/e2e/owner-flow.spec.ts:53–104`

The test title claims credential/link/theme boundaries. It checks health `401`, token absent from storage/cookie/hash/process output, and UI flow pieces — but never asserts against the real compiled server:

- unauthenticated `GET /` → `200` HTML (public snapshot)
- unauthenticated `/api/v1/*` stays `401` (already partial via health only)
- `Content-Security-Policy` / `Cache-Control: no-store` on HTML/assets
- bad `Host` / bad `Origin` → `403` even for `/`

Unit coverage in `tests/web-assets.spec.ts` covers some of this via `inject`, not via the Playwright + `api-serve --web-root` path.

**Remedy:** Add those HTTP assertions in the same e2e (or a sibling browser/http check against `address`) so regressions in public-vs-auth or CSP cannot ship behind a green “Owner flow”.

---

### 6. Low — Hash route changes remount content without moving focus
**Where:** `web/src/app.tsx:42`, `59`

`hashchange` updates route and `main` remounts via `key={route}`, but focus stays on the nav control. Skip-link exists and correctly `preventDefault`s so it does not clobber the hash router (`app.spec.tsx` covers that), but normal in-app navigation does not move focus into `#content`.

**Remedy:** On `hashchange` / after connect, focus `#content` (or the new `h1`) when the change was from in-app nav.

---

### 7. Low — Dark theme leaves alert/error chrome on light hard-coded colors
**Where:** `web/src/styles.css` (`.error-state` around the shared error rule) + `web/src/shared.tsx:8` / login alerts in `app.tsx:35`

`.error-state` uses fixed light pink/red, not `data-theme` tokens. In dark mode, `role="alert"` regions stay light-themed; weaker consistency/contrast for the same critical messages the a11y path relies on.

**Remedy:** Drive `.error-state` from theme CSS variables like the rest of the shell.

---

## No findings (in reviewed parent-owned surface)

- **Public static vs auth:** `isPublicRequest` is exact-map GET/HEAD only; Host/Origin still enforced before the bypass (`server.ts:463–488`, `web-assets.ts:60`). API paths are not in the snapshot map. Symlink/name/size bounds look fail-closed (`web-assets.ts:15–57`).
- **Credential handling (app shell):** token validated as 64-hex, held only in `createApiClient` closure, cleared from the input on success; QueryClient cleared on disconnect; e2e/unit check no `localStorage`/`sessionStorage`/cookie/hash leakage (`app.tsx:21–48`, `owner-flow.spec.ts:99–104`).
- **CSP string** on snapshotted assets includes `default-src 'none'`, `connect-src 'self'`, `frame-ancestors 'none'` (`web-assets.ts:10`, `62–66`); hooks force `Cache-Control: no-store` + `nosniff` on all responses (`server.ts:229–232`, `463–464`, `510–512`).

---

## Review limits

Read-only review of parent-owned files you listed (`web-assets.ts`, `server.ts` Web wiring, `api-commands.ts` Web/`--web-root`, `app.tsx`, `shared.tsx`, `styles.css`, `vite.config.ts`, `owner-flow.spec.ts`), plus minimal cross-reads needed to verify assertions (`auth.ts` Origin/Host, `web/src/api.ts`, `tests/web-assets.spec.ts`, button labels in `pages/tasks.tsx`, built `web/dist/index.html`). Did **not** review sibling task/API domain changes, Runtime/IM, or run installs/full `pnpm check` / Playwright. No edits made.
