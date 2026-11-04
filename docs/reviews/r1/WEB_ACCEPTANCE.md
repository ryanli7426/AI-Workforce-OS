# R1 Web first slice — parent acceptance

Date: 2026-11-05. Scope: first operational single-Owner Web slice. This is not complete PRD/UX acceptance.

## Reviewed implementation

Cursor Auto delivered the same-origin API client, Task/approval pages, overview/employee/project/execution views and their tests in three isolated worktrees. A fourth independent read-only Cursor review checked the parent's session/static-serving/CLI/E2E changes. Parent integrated and corrected the code, added session/router/visual design, explicit production build serving and real browser acceptance. Reports are retained alongside this document, not treated as self-certifying approval.

Parent corrections include real execution DTO identity, bounded response streaming and complete abort/timeout cleanup, client validation and TypeScript narrowing, resource-link hash filters, UNKNOWN occupancy retry suppression, action-in-flight controls, fresh confirmation after409, independent session cache cleanup, route focus, dark alerts and responsive table/long-revision wrapping. Execution success, verification and explicit acceptance remain separate.

## Independent review dispositions

| Finding | Disposition / evidence |
| --- | --- |
| Vite Origin differs from default API Origin | Kept restrictive default; WEB_OPERATIONS explicitly pairs development with `--allow-origin http://127.0.0.1:5173`. Production is same-origin, no wildcard CORS. |
| E2E button name differs from actual control | Corrected to actual accessible name; real approval and cancellation now verified in SQLite-backed HTTP flow. |
| Port0 origin allowlist empty for Web | Derives only the two loopback Origins from the trusted bound socket when explicitly serving Web and no allowlist was supplied; source Host is never used to construct it. Actual ephemeral-port tests and browser flow pass. API-only port0 behavior stays restrictive. |
| Vite root depends on caller cwd | Config uses absolute `fileURLToPath(new URL('.', import.meta.url))`. |
| E2E misses public/auth/Host/Origin/header assertions | Actual compiled server tested for public HTML/JS, no-store/CSP/nosniff, unauthenticated business routes, denied Host and Origin. Host probe uses node:http, because Node fetch ignores the supplied Host override. |
| Hash navigation focus | Main focus moves after connection and route changes. Skip link preserves the router hash. |
| Dark alert styling | Errors now use light/dark theme variables. |

Some audit findings referenced concurrent earlier snapshots; dispositions reflect integrated source and actual subsequent runs.

## Verification

`pnpm check` covers backend and frontend types, 43 backend test files /638 tests, 4 Web test files /50 tests, production build, no-node_modules Core/SQLite smoke, compiled CLI smoke, dependency scan and one real Chromium E2E. Browser prerequisite is installed explicitly with `pnpm exec playwright install chromium`.

Browser E2E launches the compiled CLI `api-serve --web-root` on an actual loopback socket, uses real private SQLite/Git fixtures, connects as Owner, creates a task, approves it, cancels it, checks audit and no Execution, follows employee/project filters, checks themes/mobile layout and verifies credentials do not enter browser storage/URL/Cookie/process output. No Runtime/model/IM calls or real human acceptance are simulated.

A separate actual Chromium read-only pilot displayed the original real-Claude controller execution, Task REVIEW, independent verification passed, SUCCEEDED process record and scoped stdout/stderr. Task/execution counts remained unchanged. Evidence: WEB_CLAUDE_READONLY_PILOT.json. The previous actual-Claude execution evidence remains under r0c; this Web pilot performs no new model call.

## Remaining scope

Employee/project mutation Web flows, asynchronous verification jobs/API, SSE, execution list, Runtime registry, stronger Runtime scope enforcement and OS deployment/72-hour soak are not done. Real DingTalk needs the user-selected business target and verified data representation. Organization/teams/workflows/conversations/knowledge/analytics/automation and full19-module UX still require implementation. Current seven resource views partially cover six product modules; none should be counted as full-module product acceptance solely from a menu or screenshot.
