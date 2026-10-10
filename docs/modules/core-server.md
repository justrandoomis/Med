# Core server (track: SERVER CORE)

Scope: `apps/server/src/{index,app,config,context}.ts`, `db/{db,migrate}.ts`, `lib/**`,
`modules/{auth,files,jobs,audit,sync,ai,settings}/**`, `modules/index.ts`, `cli/**`, `apps/server/test/**`.
Contracts follow [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) §3. Response shapes live in
`packages/shared/src/api.ts` (added by this track) so the web client and server share one contract.

## How other modules plug in

```ts
// apps/server/src/modules/<name>/index.ts
import type { FastifyInstance } from 'fastify';
import type { ModuleOptions } from '../../context';
export default async function register(app: FastifyInstance, { ctx }: ModuleOptions) {
  ctx.capabilities.set('library', 'available');                 // honest feature state (Arabic reason if not available)
  ctx.jobs.register('process_source', { version: '1', handler: async (run) => { /* run.checkpoint / run.progress */ } });
  ctx.sync.registerEntity('annotation', { apply(op, tx) { /* sync, inside tx; call tx.touch() */ }, serialize(id) { /* … */ } });
  app.get('/', async (req) => { const q = parseQuery(schema, req); /* … */ });
}
```
Then add `{ name, prefix: '/api/<name>', plugin }` to `MODULES` in `apps/server/src/modules/index.ts`.
Routes are authenticated automatically (global guard); use `RATE_LIMITS.upload` / `RATE_LIMITS.ai` in
route `config.rateLimit` for uploads and AI endpoints. Throw `AppError(code, messageAr, status, details?)`.
`ctx.db.tx(fn)` callbacks must be synchronous (no `await` inside a transaction).

`AppContext` = ARCHITECTURE §3.1 **plus** `settings: SettingsService` (owner settings merged with defaults).

## Implemented

| Area | What exists |
|---|---|
| Config (`config.ts`) | zod-parsed env (`.env.example`), `.env` loading (Node built-in), DATA_DIR resolution (relative → `cwd`), origin list (comma-separated; first is canonical), cookie `Secure`, trust proxy, limits, timezone validation, job tuning, AI model overrides + monthly budget, `MEDLEVO_ALLOW_EXTERNAL_FETCH`, `MEDLEVO_WEB_DIST`, `MEDLEVO_SCRYPT_LOG_N` (default 15). The AI key is only reachable via the non-enumerable `config.secrets.anthropicApiKey()`; `config.ai.anthropicKeyPresent` is the boolean. |
| DB (`db/db.ts`) | `node:sqlite` wrapper: `get/all/run/exec/tx` (BEGIN IMMEDIATE, nested → SAVEPOINT, async callbacks refused), LRU statement cache (512), positional or named params (booleans → 0/1), plain-object rows, `toJson/fromJson`, pragmas WAL + `foreign_keys=ON` + `busy_timeout=5000` + `synchronous=NORMAL`, DB file chmod 0600. |
| Migrations (`db/migrate.ts`) | `NNNN_name.sql` in filename order, each in its own transaction, full-file `exec` (FTS5 + triggers), `schema_migration(name, checksum sha256, applied_at)`; re-run no-op; edited applied migration → hard error; DB migration unknown to the build → hard error; CRLF-normalized checksums. |
| `lib/errors.ts` | `AppError(code, messageAr, status, details, headers)`, `JobError(code, messageAr, {retryable, waitForInput})`, common Arabic errors. |
| `lib/http.ts` | `parseBody/parseQuery/parseParams/parseWith` → `VALIDATION_FAILED` with Arabic per-field issues (values never echoed); `RATE_LIMITS` presets. |
| `lib/hash.ts` | sha256 (buffer/string/stream/file), HMAC, constant-time `safeEqual`, `randomToken`. |
| `lib/safe-zip.ts` | `extractZipSafe(buffer, limits, {mode:'memory'} \| {mode:'dir', dir})`: EOCD entry count checked before parsing (zip64 aware), traversal/absolute/drive/UNC/control-char names rejected (never re-rooted), symlinks ignored, `__MACOSX`/`.DS_Store` ignored, case-insensitive duplicates rejected, nested archives (by extension or magic bytes; docx/pptx/xlsx are documents) not extracted, per-entry size + total size + per-entry ratio **measured while inflating** (headers not trusted), files written `O_EXCL|O_NOFOLLOW` 0600 inside the target; accepted + rejected entries with Arabic reasons. |
| `lib/ssrf-guard.ts`, `lib/ip.ts` | `safeFetch(url, opts)`: refused unless `allowExternalFetch`; https only (http only with `allowHttp`); ports 443/80; no URL credentials; cookie/authorization never forwarded; IP literals and **every** DNS answer must be public (loopback, RFC1918, CGNAT, link-local incl. 169.254.169.254, multicast, reserved, documentation, benchmark, IPv6 ULA/link-local/site-local/multicast, IPv4-mapped/compatible/NAT64/6to4 embedded IPv4, zone ids, localhost/.local/.internal/single-label names); connection pinned to the validated address (no DNS-rebinding window); each redirect hop re-validated (max 3); timeout; size cap. |
| Other lib | `time.ts` (injectable clock, month start in owner tz incl. DST), `secret.ts` (`DATA_DIR/secret.key`, 0600, HMAC sub-keys), `useragent.ts` (Arabic device labels), `static.ts` (SPA serving), `log.ts` (pino redaction; `/api/files/t/<token>` redacted from logged URLs). |
| Auth (`/api/auth`) | `GET status`, `POST setup` (only while no owner; 10 one-time recovery codes returned once, scrypt hashes stored), `POST login`, `POST logout`, `GET sessions` (device label, UA, IP, last seen, current), `DELETE sessions/:id`, `POST password` (requires current; revokes other sessions), `POST recover` (username + code + new password; single use; revokes all sessions), `POST recovery-codes` (requires password). scrypt N=2^15,r=8,p=1 with per-hash salt, constant-time compare, dummy hash for unknown users. Cookie `medlevo_session` HttpOnly, SameSite=Strict, Path=/, Secure per config, 30-day sliding expiry (refreshed ≤ every 5 min), 32-byte token stored as sha256. Login limiter on `login_attempt`: 5 failures/min/IP + exponential lockout (1 min doubling to 1 h) after 10 consecutive failures — each attempt is checked AND reserved as a failure synchronously before the async scrypt verification (`limiter.begin` → `limiter.succeed`), so parallel guesses count against each other; shared by login, recover, password change and recovery-code regeneration; plus coarse `@fastify/rate-limit`. Security events audited. |
| Guard | Root `onRequest`: applies to every request that matched a route (all server routes are API routes — fail closed) and to unmatched requests whose raw **or percent-decoded** path is under `/api` (`isApiRequest`; the router decodes `/%61pi/…` to `/api/…`). CSRF for every non-GET/HEAD/OPTIONS `/api` request (`x-medlevo-csrf: 1`, Origin ∈ configured origins, `sec-fetch-site ≠ cross-site`) — public credential endpoints included; owner session required for every `/api` route except `PUBLIC_ROUTES`. No CORS. |
| Files (`/api/files`) | `FileStore` (content-addressed `DATA_DIR/files/aa/bb/<sha256>`, dedup, temp + fsync + atomic rename, size cap while streaming, self-heals a missing blob on re-upload). `GET /:id` (session; single Range incl. suffix/open; 416; HEAD with the real Content-Length; ETag/If-None-Match; `nosniff`; `private` cache; inline with RFC 5987 filename; active types forced to download), `GET /:id/meta`, `POST /:id/token` (≤ 1 h), `GET /t/:token` (HMAC-SHA256 token bound to file id + expiry; no session). |
| Jobs (`/api/jobs`) | `JobQueue` per §3.3: register/enqueue (idempotency key; optional input schema)/cancel/retry/get/list/start/stop/drain/requeueStale; polling worker with global + per-kind concurrency; `run.checkpoint` (job_checkpoint, resumes after retry/crash), `run.progress` (real counts, clamped), `run.signal` (timeout, cancel, shutdown), `isCancelled`; exponential backoff (2 s doubling, cap 5 min) for retryable errors until `max_attempts`; fatal → `failed`; `waiting_for_input`; `partial` ≠ `completed`; cancel keeps checkpoints/outputs; heartbeat + stale-running re-queue on boot and periodically; graceful stop re-queues interrupted jobs without consuming an attempt. Unknown exceptions → `INTERNAL` with an Arabic message; stack traces only in server logs. Routes: `GET /`, `GET /:id`, `POST /:id/cancel`, `POST /:id/retry` (audited). |
| Audit (`/api/audit`) | `AuditLog.record()` → `change_log` (secret-looking keys redacted); `GET /api/audit?entity_type&entity_id&limit&before`. |
| Sync (`/api/sync`) | `SyncRegistry` per §3.4: `registerEntity`, `touch` (one feed row per entity at its latest seq), `push` (each op in its own tx; repeated `op_id` → `duplicate` + `original_result`; handler `AppError` → `rejected` (recorded); unknown entity type or unexpected error → `rejected` + `retryable: true`, **not** recorded, rolled back), `pull(since, limit)` with paging; `server_seq` stored per op. Capability `sync` is `not_implemented` (Arabic reason) while no entity type is registered and becomes `available` as soon as an owning module calls `registerEntity` (`onRegister` listener). `touch()` is atomic on its own (SAVEPOINT when nested). |
| AI (`/api/ai`) | `AiOrchestrator` per §3.5: `status()` per task, `isAvailable`, `budget()` (month in owner tz, **estimated** costs), `generateStructured()` — `AI_NOT_CONFIGURED` without provider/unsupported task, Source Lock check (`OUT_OF_SCOPE` if a version is outside `scope.versionIds`), budget guard with worst-case pre-estimate (`AI_BUDGET_EXCEEDED`, `budget_blocked` record), untrusted content wrapped in nonce-bounded blocks with injected tags neutralized + security policy in the system prompt, zod validation with exactly one repair attempt then `SCHEMA_REJECTED`, `usage_record` for every provider call (`ok`/`error`/`schema_rejected`/`budget_blocked`; no prompt text). `providers/index.ts` → `createProviderFromConfig()` returns the Anthropic adapter when `ANTHROPIC_API_KEY` is set and `null` otherwise (reconciled in track F5; see Not done). `GET /api/ai/status`, `GET /api/ai/usage`. |
| Settings (`/api`) | `GET/PATCH /api/settings` (shared `ownerSettingsSchema`, merged with defaults, unknown keys rejected, timezone validated, invalid stored value → default for that key, audited); `CapabilityRegistry` + `GET /api/capabilities`: every feature `not_implemented` with an Arabic reason unless a module sets it; AI-dependent features → `requires_configuration` when no provider. |
| App / boot | `buildApp({ config, overrides, modules })`: helmet (SPA CSP; strict `default-src 'none'; sandbox` CSP + `no-store` on every `/api` response; `X-Frame-Options: DENY`; no-referrer), cookie, multipart (limits from config), rate-limit (`global:false`), error handler (`ApiErrorBody`, Arabic, no internals), 404 handler, `GET /api/health` (public), modules. `index.ts`: `.env` → config → open DB → migrate → app → `jobs.start()` → listen; SIGINT/SIGTERM → close (stop jobs, close DB). Production serves `apps/web/dist` (or `MEDLEVO_WEB_DIST`) with SPA fallback for non-`/api` navigations. |

### Deviations / additions to the contract (documented here, ARCHITECTURE.md not edited by this track)
* `GET/HEAD /api/files/t/:token` is a **public** route: the short-lived HMAC token is the credential (pre-signed URL).
* `AppContext.settings` added. `JobView` (shared/api.ts) is what `enqueue/get/list` return (parsed JSON fields).
* `generateStructured` also accepts `instruction` (trusted request text), `rulesVersion`, `signal`, `timeoutMs`.
* `SyncOpResult` carries `original_result` for duplicates and `retryable` for transient rejections.
* `POST /api/auth/recover` does not log in; the owner logs in with the new password (all sessions revoked).

## Tested

Commands run (real results, 2026-10-09):
* `npm test -w @medlevo/server` → **11 files, 143 tests passed** (builder); after the independent review fixes → **11 files, 150 tests passed**.
* `npx tsc -p apps/server --noEmit` → exit 0. `npx tsc -p packages/shared --noEmit` → exit 0; `npm test -w @medlevo/shared` → 18 passed.
* Manual boot (`tsx src/index.ts` on a temp DATA_DIR): health, status, 401 for jobs, CSRF 403, setup 200 with cookie and headers — as expected.

Test files (`apps/server/test/`): `migrations` (fresh incl. FTS trigger + MATCH, re-run no-op, checksum mismatch, failed migration rollback, unknown applied migration, Db tx/savepoints/async refusal), `auth` (setup once, second setup rejected, hashes only, validation, Secure cookie, login ok/wrong, 5/min limit, exponential lockout, logout, sessions list/revoke + audit, sliding expiry + expiry, password change revokes others, recovery code single use, regenerate codes, unauthenticated denied for protected routes), `csrf` (missing header, bad/null Origin, cross-site, login CSRF), `files` (dedup, stream, size cap, secret 0600, unauthenticated 401, headers, Range variants + 416, active content download, 404, token access/expiry/tampering/binding, TTL cap), `jobs` (idempotency, checkpoint resume, retryable vs fatal, no stack traces, partial vs completed, cancel keeps checkpoints + retry resumes, cancel queued, stale-running requeue, timeout via AbortSignal, waiting_for_input, input schema + progress clamp, worker loop concurrency, API + audit), `sync` (idempotent op_id, append-only duplicate, conflict_kept_both passthrough, rejected recorded vs retryable not recorded, validation, pull paging/one row per entity/tombstones), `ai` (not configured + capabilities, ok + usage without prompt text, delimiter neutralization, schema rejection after one repair, repair success, budget block incl. month boundary, zero budget, Source Lock, provider error mapping, unsupported task), `safe-zip` (normal, traversal, absolute, symlink, system files, nested archives, duplicates, too many entries, ratio bomb, total limit, lying headers, invalid archive, dir mode), `ssrf` (127.0.0.1, 10.x, 172.16, 192.168, 169.254.169.254, CGNAT, 0.0.0.0, [::1], ::ffff:127.0.0.1, ::ffff:a9fe:a9fe, fd00::/8, fe80::, NAT64, decimal/hex IPv4, localhost, *.localhost, metadata.google.internal, single-label, DNS answers mixing private, redirect to metadata/private/http, redirect cap, schemes/credentials/ports, header stripping, size cap, IP classification table), `app` (health, 404, malformed JSON, 413, security headers, settings defaults/patch/validation/audit/fallback, audit paging + redaction, config secrets + parsing, static SPA serving), `lib` (validation messages, tz month start incl. DST, UA labels, ranges, JSON extraction, scrypt + recovery code normalization, DB file mode, graceful shutdown re-queue).

## Independent review (2026-10-09)

Fixed (each with a regression test):
* **Blocker — auth + CSRF bypass via percent-encoded paths.** The guard (and the API CSP hook) looked only at the raw
  `req.url`, but the router decodes paths: `GET /%61pi/auth/sessions`, `/%61pi/audit`, `/%61pi/settings` answered 200
  without a session and `PATCH /%61pi/settings` succeeded without session or CSRF header. Now decided by `isApiRequest()`
  (matched route → always guarded; unmatched → raw or decoded `/api` path). Verified with `inject` and over a real socket.
* **Login limiter race.** The 5/min check ran before the async password hash and failures were recorded after it, so a
  parallel burst of 20 wrong passwords got 20 checks (all 401, none 429). Now 5 × 401 and 15 × 429.
* **Cancel vs. shutdown race.** A job cancelled just before `stop()` was re-queued (attempt given back) and would run
  again on the next boot. Cancel now takes precedence.
* **Honesty:** capability `sync` was `available` although no entity type can be synced yet (every push answered
  `rejected`/retryable). It now reflects the registered entity types.
* **HEAD on files** answered `Content-Length: 0`; now the real length (full, ranged and token routes).
* **Test helper `login()`** (ARCHITECTURE §5) threw `SETUP_REQUIRED` on a fresh app; it now creates the owner first.
* `sync.touch()` made atomic on its own (DELETE + INSERT can no longer be split by a failure).

Open (minor, not fixed):
* First-run setup is public until the owner exists (whoever reaches the server first can claim it). Default bind is
  `127.0.0.1`; exposing the server before setup is a deployment risk. A one-time setup token would need a web change.
* `MEDLEVO_COOKIE_SECURE` defaults to `false` even when `MEDLEVO_ORIGIN` is https (documented in `.env.example`).
* The AI budget pre-check is not atomic across concurrent calls (overshoot ≤ one worst-case call per extra concurrent call).
  `ai.status()` can report a task available while the worst-case estimate of the next call no longer fits.
* `GET /api/sync/pull` returns `entity: null` both for deleted entities and for entity types without a registered
  handler — a module that calls `touch()` for a type it never registered would look like a deletion to clients.
* SVG files are served inline as `image/svg+xml`; script execution is blocked by the `sandbox` API CSP, not by the type.
* A signed file URL stays valid until it expires (≤ 1 h) even after logout/password change.
* A `ZodError` thrown by internal (non-request) code is reported as `VALIDATION_FAILED` 400 instead of 500.

## Not done (and why)
*Reconciled with the code in track F5 (2026-10-10): the first three items were built by later tracks and are struck
through with where they live now; the rest still hold.*
* ~~**Anthropic adapter** (`modules/ai/providers/anthropic.ts`): intentionally not implemented in this track.~~ Built in
  track C2 (ADR-0002): `createProviderFromConfig()` returns it when `ANTHROPIC_API_KEY` is set, `null` otherwise — then
  every AI feature reports `requires_configuration` with its Arabic reason. It has never run against the real API here
  (no key); every AI path is tested with the test-only scripted / fake providers.
* ~~**Backup / restore-verify CLIs** are stubs; capability `backup` stays `not_implemented`.~~ Built in track D1
  (`cli/backup.ts`, `cli/restore-verify.ts`, capability `backup` available; docs/BACKUP_RESTORE.md, AC-30).
* ~~**Concrete sync entity handlers** belong to their owning modules; only the generic engine exists.~~ Registered by
  their modules: `annotation`, `note`, `note_page`, `study_session` (annotations), `flashcard`, `review_event`
  (learning), `question_attempt`, `exam_attempt` (exams).
* The default SSRF transport (`node:https` pinned to the validated IP) is not exercised against the real network in tests (no outbound network in CI); redirect/IP logic is tested through an injected transport and resolver.
* Not run: the zip-bomb tests use in-memory synthetic archives (no real-world bombs); scrypt cost in tests is lowered to 2^12 via `MEDLEVO_SCRYPT_LOG_N` for speed (production default 2^15).
* Jobs of a kind that no module registers stay `queued` (they are listed in the API); a handler that ignores its `AbortSignal` keeps running in the background after a timeout/cancel (its later `progress()` calls are ignored; checkpoints are idempotent).

## Integration round I1 (2026-10-10)
* **Settings PATCH merges `source_priority` per purpose.** A PATCH with a partial `source_priority` object used to
  reset the omitted purposes to their defaults (zod defaults on `{ ...before, ...patch }`). Server and web store now
  use the shared `mergeSettingsPatch` (`packages/shared/src/settings.ts`, `NESTED_SETTING_KEYS`). The web store also
  merges the pending (unsent) patch per purpose, so two quick edits to different purposes both reach the server.
  Tests: server `test/app.test.ts`, web `test/stores.test.ts`.
* `.env.example` now documents `MEDLEVO_SETUP_TOKEN` and `MEDLEVO_SOFFICE_AVAILABLE`; `test/env-example.test.ts`
  fails when the server reads a `MEDLEVO_*`/`ANTHROPIC_*` variable the example does not name, or when the example
  carries a value for a secret.

## Integration round I2 — crash resume latency (2026-10-10)
* **After a crash the job sat «running» for a minute.** A SIGKILL of a real server mid-processing (300-page lecture)
  left the job `running` with a fresh heartbeat; the restarted server waited for `staleAfterMs` (60 s) before
  resuming — measured 61.6 s from restart to resume. The queue now records the claiming process in
  `processing_job.worker_id` (`<hostname>/<pid>/<boot nonce>`, migration `0030_job_worker.sql`) and re-queues at once a
  job whose claimer is provably gone (same host and the pid no longer exists, or the same pid with another boot nonce —
  a restarted container's pid 1). Unknown owners (NULL, another host, a live pid) keep the heartbeat rule, so two live
  servers never take each other's jobs. Measured after: resume 1.8 s after the restart (boot 1.6 s), integrity
  unchanged (no duplicated regions / review items / assets; checkpointed pages not redone).
  Tests: `test/jobs-crash.test.ts` (4 of 5 fail on the old code; the 5th is the safety property),
  `test/perf/crash-resume.perf.test.ts` (real process, `MEDLEVO_PERF=1`).
