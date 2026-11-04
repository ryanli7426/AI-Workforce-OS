# Cursor Auto: authenticated HTTP application transport

Own ONLY `src/api/server.ts`, `tests/api-server.spec.ts`. Read AGENTS.md, CURSOR_API_FOUNDATION.md, actual ProductQueries/LocalTaskCommands/LocalTaskService/auth implementations. Parent provides reviewed parallel auth+command modules and schema composition. Do not invent replacements. Fastify5.12.8 is pinned by parent; Node22, TypeScript ESM. No other edits, installs, commits, pushes, nested agents or real service/model calls. Parent owns api-serve CLI and listening.

Export `createApiServer({store:LocalStore,settings:LocalSettings,authenticator:{authenticate(header:unknown):{ownerId:string,workspaceId:string}},allowedOrigins:readonly string[],dataDir:string}):FastifyInstance`. Factory does not initialize/migrate schemas, listen, start Runtime/controller or alter process environment. Require actual already-initialized current modules plus command receipt schema; caller owns store lifetime. Snapshot trusted options. Authenticated principal must exactly match settings Owner/workspace; never read actor from body. Validate request Host/Origin via actual assertLocalRequest, reject duplicate Authorization raw headers, authenticate ALL routes (including health), no anonymous data/credential leaks. No cookies/CORS wildcard/auth bypass. Bind/listen loopback enforced by parent CLI. GET state reflects persisted facts, not invented Runtime liveness.

Fastify loggerfalse, disable raw request/body/header logs; body limit128KiB, bounded request/connection timeouts; `trustProxy:false`; JSON schema validation must reject unknown fields and type coercion (`removeAdditional:false`, `coerceTypes:false`, `useDefaults:false`). Stable errors `{error:{code,message}}`, sanitized bounded/static messages. INVALID_REQUEST400, UNAUTHORIZED401, invalid Host/Origin403, NOT_FOUND404, VERSION_CONFLICT/IDEMPOTENCY_CONFLICT/STATE_CONFLICT409; unknown failure500 generic. Never echo AJV values or secret-shaped unknown keys. Set Cache-Control:no-store and nosniff. Parameterized paths/queries, strict duplicate/unknown query/body keys.

Routes under `/api/v1`:
- GET `/health` → `{ready:true,workspaceId}` after actual factory preflight, no CLI/model probe.
- GET `/me` → authenticated principal + role owner only.
- GET `/overview`, `/employees`, `/projects` → actual ProductQueries views.
- GET `/tasks` → ProductQueries.tasks with typed query limit/beforeRowid, comma-separated states, projectId/employeeId. Arrays/duplicate/bad values reject; no arbitrary source/Owner selector.
- GET `/tasks/:ticketId` → actual bounded detail or404.
- GET `/executions/:executionId` → scoped record or404.
- GET `/tasks/:ticketId/logs` → actual readExecutionLogs(dataDir,ticketId, optional executionId,maxBytes); ensure authenticated current Task scope. No arbitrary path.
- POST `/tasks` body actual CreateTaskInput projectId/issueId/title/description/taskType/priority. Required `Idempotency-Key`; LocalTaskCommands.execute(key,{kind:'create',input:body}), response201 `{ticket,replayed}` and `Idempotency-Replayed` header.
- POST `/tasks/:ticketId/approve|reject|cancel|retry` body `{expectedVersion,reason}`; same receipt, response200.
- POST `/tasks/:ticketId/review` body `{expectedVersion,executionId,artifactRevision,approved,reason}`; same receipt200. No verification-passed shortcut; Core rejects premature review.

No simulated SSE, Runtime operations, arbitrary check execution, controller start, approval inference or automatic DONE. Async verification API will be a separate durable operation, not a forged passed field. Unsupported routes truly404. Employee/project mutation routes arrive via their application services separately; do not wrap Git validation in a transaction here.

Tests Fastify.inject against real temp SQLite, actual settings/authenticator/command processor/read models; no fake dependencies. Parent will copy reviewed modules and initializer hookup. Verify every endpoint unauthorized; valid bearer/Origin/Host gates, malformed/malicious bodies, actual create/approve replay after DB reopen, conflicts/version races, cross-owner and crossworkspace exclusion before pagination, no verification/review bypass, no filesystem/DB initialization on query/factory. Token not in errors, responses or event/audit data. Close app/DB and clean owned files. Meaningful HTTP boundary tests; no skips/source-grep gates. Report actual dependency blockers; parent runs final full gates and real TCP acceptance.

Official API references: https://fastify.dev/docs/latest/Reference/Server/ and https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/ . Only static application schemas are trusted; user schemas are forbidden.
