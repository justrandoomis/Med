# Deployment (§49, §61)

MedLevo is one Node.js process (API + the built web app) with an embedded SQLite database and a private file store
under one data directory. It is built for **one owner** on a machine the owner controls. This page is the production
setup: reverse proxy and TLS, the environment, the first-run setup token, backups on a schedule, and the update plan for
sources, models and the database schema. The setup below is **exercised by an automated test**
(`apps/server/test/deploy/tls-proxy.test.ts`, §7) — on this container, not on a real host or a public certificate.

> **No computer?** The owner's own setup is a hosted one, done entirely from a phone or an iPad: Render (Docker image
> from this repository + a persistent disk) and Cloudflare R2 for encrypted off-site backups. Step-by-step Arabic guide:
> [`DEPLOY_PHONE_AR.md`](DEPLOY_PHONE_AR.md); the technical side (image, blueprint, proxy trust, restore design) is §8.

## 1. Requirements

* Node.js ≥ 22.13 (built-in `node:sqlite`), npm.
* poppler (`pdftoppm`, `pdftotext`) for page rendering / OCR input; LibreOffice (`soffice`) only for legacy
  `.doc` / `.ppt` (refused with a reason without it). OCR models (eng + ara) ship with the app.
* A reverse proxy that terminates TLS (nginx, Caddy, …) and a certificate for your host name.
* Disk: the data directory holds the database, every uploaded file, page images and backups — plan for several times
  the size of your sources.

## 2. Build and run

```bash
git clone … medlevo && cd medlevo
npm ci
npm run build                                    # apps/web/dist (PWA)
sudo mkdir -p /srv/medlevo/data && sudo chown medlevo: /srv/medlevo/data
```

`/etc/medlevo.env` (mode 600, owned by the service user — never in the repository):

```bash
NODE_ENV=production
MEDLEVO_DATA_DIR=/srv/medlevo/data              # absolute in production
MEDLEVO_HOST=127.0.0.1                          # loopback: only the proxy can reach the app
MEDLEVO_PORT=8787
MEDLEVO_ORIGIN=https://medlevo.example.org      # the EXACT origin the browser opens
MEDLEVO_TRUST_PROXY=true                        # only because the proxy below is the sole client
MEDLEVO_SETUP_TOKEN=                            # empty: a one-time token is printed at boot (or set your own long value)
MEDLEVO_TIMEZONE=Asia/Baghdad
# MEDLEVO_COOKIE_SECURE is true automatically for an https origin
# ANTHROPIC_API_KEY=…                           # optional; server only, never logged, exported or backed up
```

systemd unit (`/etc/systemd/system/medlevo.service`):

```ini
[Unit]
Description=MedLevo
After=network.target

[Service]
User=medlevo
WorkingDirectory=/opt/medlevo/apps/server
EnvironmentFile=/etc/medlevo.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning --import tsx src/index.ts
Restart=on-failure
# graceful stop: running jobs are re-queued and resume from their checkpoints at the next boot
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/srv/medlevo/data

[Install]
WantedBy=multi-user.target
```

(`npm start` runs the same entry point.) Health: `GET /api/health` → `{ ok, version, time }`.

## 3. Reverse proxy and TLS

The proxy terminates TLS and forwards to `127.0.0.1:8787`. It must:

* **overwrite** `X-Forwarded-For` with the real client address (never append a client-supplied value), and set
  `X-Forwarded-Proto: https` and the original `Host`. With `MEDLEVO_TRUST_PROXY=true` the server trusts these headers
  (Fastify `trustProxy`): the client address is what sessions and the login rate limiter record. That is safe **only**
  when nothing but the proxy can reach the app — keep `MEDLEVO_HOST=127.0.0.1` (or a firewall). `true` takes the
  **left-most** `X-Forwarded-For` entry, which is the proxy's own observation only because the proxy overwrote the
  header. Behind a proxy that **appends** (a platform, a CDN) use a hop count or an address list instead (§8.2):

  | `MEDLEVO_TRUST_PROXY` | the client address is | use it for |
  |---|---|---|
  | `false` (default) | the TCP peer | direct exposure, or no proxy |
  | `true` | the left-most `X-Forwarded-For` entry | your own nginx / Caddy that overwrites the header (this section) |
  | `1`…`10` | the entry that many places from the right | a known number of proxies that each append one entry (Render: `1`, together with the header below) |
  | `10.0.0.0/8,…` (addresses, CIDR ranges, `loopback`, `linklocal`, `uniquelocal`) | the right-most entry not in the list | proxies whose addresses you know |

  `MEDLEVO_CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) additionally names a header that the platform's edge sets to the
  client address; it is honoured only from a trusted proxy and only when it holds exactly one IP address;
* allow uploads up to `MEDLEVO_MAX_UPLOAD_MB` (default 200 MB) and long requests (processing is asynchronous, but an
  upload of a large PDF takes time);
* not cache `/api/*` (the server sends `Cache-Control: no-store` and a strict CSP on every API response).

nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name medlevo.example.org;
  ssl_certificate     /etc/letsencrypt/live/medlevo.example.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/medlevo.example.org/privkey.pem;
  client_max_body_size 210m;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;   # overwrite, do not append
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 300s;
    proxy_request_buffering off;
  }
}
server { listen 80; server_name medlevo.example.org; return 301 https://$host$request_uri; }
```

Caddy (a Caddyfile block opens a line with `{` and closes on its own line; one-line blocks are not valid):

```caddyfile
medlevo.example.org {
	request_body {
		max_size 210MB
	}
	reverse_proxy 127.0.0.1:8787 {
		# overwrite, do not append (Caddy also drops an X-Forwarded-For from untrusted clients by default)
		header_up X-Forwarded-For {remote_host}
	}
}
```

What the server then guarantees (and the test checks through https):

* the session cookie is `HttpOnly; SameSite=Strict; Path=/; Secure` (secure because the origin is `https://`), and
  every response carries `Strict-Transport-Security`;
* every mutation needs `x-medlevo-csrf: 1`; a request whose `Origin` is not exactly `MEDLEVO_ORIGIN` (another site, or
  `http://` for the `https://` site) or whose `Sec-Fetch-Site` is `cross-site` is refused (403). There is no CORS;
* the app shell is served by the same process with its CSP; private files are served only to the owner session or by
  short-lived signed links.

`MEDLEVO_ORIGIN` may list several origins separated by commas (the first is canonical) — e.g. the public name and a
LAN name. Anything not listed cannot mutate.

## 4. First run: claiming the owner account

Before the owner exists, whoever reaches the server first could claim it. When the server is reachable beyond this
machine — a non-loopback `MEDLEVO_HOST`, `MEDLEVO_TRUST_PROXY=true`, or a non-loopback `MEDLEVO_ORIGIN` — creating the
owner needs a **setup token**:

* `MEDLEVO_SETUP_TOKEN` set → that value (also required on loopback); it is never printed;
* otherwise a one-time token is printed in the server log at boot (`journalctl -u medlevo | grep "setup token"`),
  kept only as a hash in memory, consumed by the setup, and a restart prints a new one.

The setup screen asks for it. Recovery codes are shown once at setup — store them offline.

## 5. Backups on a schedule

Backups are consistent while the server runs (SQLite `VACUUM INTO` + the content-addressed file store). Local archives
are **not encrypted**; the offline copy on a device is not a backup. Full procedure: [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md).
With Cloudflare R2 configured, the server itself runs a daily, verified, **encrypted** off-site backup with retention
and shows it in the Control Center («النسخ الاحتياطي خارج الخادم») — [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) §6; the
timer and copy steps below are then only needed for a second, independent copy.

| when | what |
|---|---|
| daily (e.g. 03:15) | `npm run backup` → `<DATA_DIR>/backups/medlevo-backup-….tar.gz` + `.sha256` |
| weekly | `npm run restore:verify -- <newest archive>` (restores into a temporary directory, checks every file, the database, migrations and boots the app on it); alert on a non-zero exit |
| after each backup | copy the archive + `.sha256` **off the machine** (another disk / host, encrypted at rest) |
| retention | keep 7 daily, 4 weekly, 6 monthly; delete older archives from `<DATA_DIR>/backups` |
| before every update | a backup **and** its verification (§6) |

systemd timer for the daily backup:

```ini
# /etc/systemd/system/medlevo-backup.service
[Service]
Type=oneshot
User=medlevo
WorkingDirectory=/opt/medlevo
EnvironmentFile=/etc/medlevo.env
ExecStart=/usr/bin/npm run backup

# /etc/systemd/system/medlevo-backup.timer
[Timer]
OnCalendar=*-*-* 03:15
Persistent=true
[Install]
WantedBy=timers.target
```

A restore always goes into a new, empty directory (`npm run restore:verify -- <archive> --target <empty dir>`); point
`MEDLEVO_DATA_DIR` at it and restart. Devices notice the restore (server epoch) and re-send what they had not synced.

## 6. Update plan — code and schema, models, sources

> **Release R1-b — the first boot on an existing (R1-a) data directory runs the owner migration (P1-T1 step 3).**
> This release keeps every account in its own database (`system.sqlite` + `vaults/<id>.sqlite`, ADR-0003). On a data
> directory that still holds the single-owner `medlevo.sqlite`, the server does **not** start the app and never offers
> first-run setup: it starts a **maintenance page** on the same port (`/api/maintenance`) and waits for the owner to
> start the migration — a verified backup, then the database moved byte for byte into user #1's vault. The full
> procedure, what the owner sees and the rollback are in **§6.1**. A fresh data directory starts as before (first-run
> setup creates account #1, the platform admin). New settings: `MEDLEVO_DB_POOL_SIZE` (open user databases, lowered to
> fit the open-file limit), `MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR` and `MEDLEVO_OWNER_MIGRATION` (`off` | `apply` |
> `rollback`, §6.1) (`.env.example`).
>
> **P1-T1 step 2 settings** (same release; `.env.example`): `MEDLEVO_USER_STORAGE_QUOTA_MB` (default 2048 for every
> account except the first, which has no storage limit until the platform admin sets one) and
> `MEDLEVO_SPACE_STORAGE_QUOTA_MB` (20480, subject spaces arrive with R1-c); AI for accounts other than the first is
> off until the platform admin sets a monthly cap (`PUT /api/platform/quotas/users/:userId`), and
> `MEDLEVO_AI_MONTHLY_BUDGET_USD` stays the ceiling over everyone; `MEDLEVO_BLOB_GC_SCHEDULE` (default `04:20`, the
> daily file clean-up check — files go only after two checks ≥ 7 days apart plus 30 days in quarantine);
> `MEDLEVO_UPLOAD_CHUNK_MB` (8, resumable uploads); `MEDLEVO_BLOB_STORE` (`local` by default; `r2` also keeps an
> encrypted copy of every file in R2 under content-addressed keys and needs the R2 settings and
> `MEDLEVO_BACKUP_ENCRYPTION_KEY` — the server refuses to start with `r2` when one is missing). New directories under
> the data directory: `quarantine/` (files the GC moved out of the store), `exports/` (users' «نسخة من بياناتي»),
> `backups/vaults/` (per-vault backups and the rollback copy of a vault restore). Backups and restore:
> [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) §7.

**Code and database schema** (migration safety):

1. Backup + `restore:verify` (§5). Note the current commit (`git rev-parse HEAD`).
2. `git pull && npm ci && npm run build`; optionally `npm run eval -- --compare=docs/eval/baseline.json` on the new
   code to see accuracy changes before switching (docs/EVALUATION.md).
3. Restart. Migrations run automatically at boot, **forward only**, in file order, each in its own transaction; a
   failing migration is rolled back completely and the server does not start. An applied migration that was edited
   (checksum mismatch) or a database newer than the code (a migration the build does not have) stops the server with a
   precise message instead of running on a mismatched schema.
4. Check `GET /api/health`, the Control Center («المعالجة», «صحة النظام») and open a source.
5. **Rollback**: stop the server, check out the previous commit (`npm ci && npm run build`). If the new version applied
   migrations, the old code refuses the newer database (by design) — restore the backup taken in step 1 into a new
   directory and point `MEDLEVO_DATA_DIR` at it. Writing done after the update and not yet in a backup is re-sent by
   the devices that still hold it in their outbox; anything else written only on the server after the update is lost
   by a rollback, so roll back early or export first.

**Models** (`MEDLEVO_MODEL_GENERATION / _VERIFICATION / _VISION`, `ANTHROPIC_API_KEY`): preview the impact in the
Control Center («الذكاء الاصطناعي» → impact preview lists the content generated with that role's model), change the
environment value, restart. Content generated earlier keeps its recorded model and is never regenerated
automatically. Compare quality before/after with `npm run eval -- --mode=live` (needs the key). Roll back by
restoring the previous value and restarting.

**OCR / chunking / retrieval / explanation rules**: versioned in code (`PIPELINE_VERSION`, `INDEX_VERSION`,
`GENERATOR_VERSION`, `AI_RULES_VERSION`, `VERIFIER_VERSION`); the compare-and-rollback procedure is in
[`EVALUATION.md`](EVALUATION.md) §4. Existing sources are re-processed only when you ask («إعادة المعالجة»), and
owner corrections survive re-processing.

**Sources**: a new edition of a lecture or book is uploaded as a **new version** of the same source («النسخ»): the old
version, its citations, notes and attempts stay; content alerts list what may be affected; «تثبيت هذه النسخة للدراسة»
(Source Freeze) keeps studying on the version you choose. A source in the trash keeps everything until you purge it.

### 6.1 Updating an R1-a installation: the owner migration (release R1-b, P1-T1 step 3)

ADR-0003 §5. The release that migrates the owner contains **no new base migration** (BUILD_PLAN §1.3): the moved
database is exactly the R1-a database, so it can be moved back. Before updating, run R1-a once on the data (it applies
its own migrations); a database older than R1-a is refused with that instruction, a newer one too — nothing is changed.

**What happens at the first boot of R1-b** (`src/system/maintenance.ts`, `planBoot` → `startMaintenance`):

| data directory | what the server does |
|---|---|
| only `medlevo.sqlite` (R1-a) | maintenance page, **waits** for the owner (or starts at once with `MEDLEVO_OWNER_MIGRATION=apply`) |
| a migration journal that is not complete (a crash, a redeploy, a kill) | **resumes** at once from the last completed step |
| migrated (`system.sqlite` + `vaults/` + `.multi-user`) | the app, as on any multi-user directory; the journal records `first_boot` with checksums and row counts again |
| `MEDLEVO_OWNER_MIGRATION=rollback` | moves the vault back to `medlevo.sqlite` (below), then shows «تم التراجع» and stays there |
| vault files without `system.sqlite`, or a real `medlevo.sqlite` beside a multi-user directory | a page that says why; nothing is changed; **setup mode never runs over existing data** |
| an empty / torn `migration-journal.json` beside `medlevo.sqlite` (a crash before its first line reached the disk) | treated as «nothing started»: the page waits; the empty file is set aside when the migration starts (review fix) |

While the maintenance page is up: `GET /api/health` → 200 `{ ok: true, maintenance: true }` (Render's health check
passes, the deploy goes Live); `GET /api/auth/status` → signed out, `setup_required: false`; every other `/api` route →
503 `FEATURE_DISABLED` with an Arabic message naming `/api/maintenance` (an installed R1-a app shows its sign-in screen
and that message; what it wrote offline stays in its outbox); any other page address → the maintenance page itself.
The page (Arabic, RTL, no JavaScript, strict CSP, 44 px targets, light / dark / high contrast) asks for the owner's
**current** username and password — or an unused recovery code, which is checked and **not** consumed — and an explicit
confirmation. Wrong credentials are rate-limited (10 failures from one address → refused for 15 minutes); a cross-site or foreign-Origin POST is
refused.

**The steps** (journal `DATA_DIR/migration-journal.json`, one fsync'd JSON line per step; each step re-checks its own
result on resume): `freeze` (WAL checkpoint, `integrity_check`, `foreign_key_check`, the owner row exists, the applied
migrations are exactly the shipped base set) → `safety` (sha256 + size + per-table row counts of the database as the
reference; a full backup into `DATA_DIR/migration/` restored into a temporary directory and booted there; with R2
configured, an encrypted copy uploaded to `<MEDLEVO_R2_PREFIX>backups/…mlenc`) → `system_db` (written as
`system.sqlite.migrating.tmp`: user #1 with the owner's username, password hash, recovery-code hashes and creation time
verbatim, platform admin + `legacy_owner`; the active sessions with the same token hashes — devices stay signed in;
devices seeded from the sessions and the sync log, so cursors and the epoch continue; blob rows; unfinished jobs) →
`move_vault` (a rename on the same disk to `vaults/<vault>.sqlite`; its sha256 must equal the reference; a small text
**tombstone** is then written at `medlevo.sqlite` — SQLite refuses it, so R1-a deployed by mistake stops with «file is not
a database» instead of creating an empty database and offering setup; this build recognises it) → `commit`
(system DB renamed into place, the marker `.multi-user` written last) → `verify` (sha256 and row counts again, before the
first boot) → `complete`. A failure before the move that cannot be retried (no owner, a wrong schema) aborts with the data
untouched (the journal is renamed `migration-journal.aborted-<time>.json`); any other failure leaves the journal in
progress and the page offers «أعد المحاولة» (resume) and «تراجع». An R2 failure can be skipped from the page (the local
verified backup stays). The migration refuses to run twice (`ALREADY_MIGRATED`).

**Disk space**: about 2.2 × (database + files) + 64 MB free on the data disk (backup + its restore check); the page and
`--dry-run` say when it is missing (on Render: Disks → enlarge, then «أعد المحاولة»).

**CLI** (`npm run migrate:multi-user -- …`; in the Docker image `medlevo-migrate-multi-user …`, which runs as the
`node` user and uses the running server's `MEDLEVO_DATA_DIR`): `--dry-run` (default; what would happen, changes
nothing), `--status` (the journal), `--apply`, `--resume`, `--rollback`; `--data-dir`, `--skip-offsite`, `--json`. Exit
0 done · 1 failed (nothing lost; the reason is printed) · 2 refused. `--apply` / `--resume` / `--rollback` refuse while a
server runs on the same data directory (`DATA_DIR/server.lock`): on a host where the server is a service (Render), use
the page or the variable. An **R1-a** server writes no lock, so the CLI cannot see one: stop it first (on Render the
deploy of R1-b replaces it; seen in the review: the CLI ran next to a still-running R1-a process).

**Rollback** (valid only because no base migration ships with the move): `MEDLEVO_OWNER_MIGRATION=rollback` and a
restart (or `--rollback` with the server stopped, or «تراجع» on the page after a failure). The marker is set aside
first; the owner's current password and recovery codes are copied back into the `owner` row if they changed after the
migration, and every session that is no longer valid under R1-b (revoked by a password change or «sign out this device»)
is revoked in the vault too (review fix — it came back to life before); the tombstone is set aside; the vault (with
everything written since — it **is** the R1-a database) is moved back to `medlevo.sqlite`;
`system.sqlite`, its WAL files and the journal go to `DATA_DIR/rolled-back-<time>/` (never deleted). Resumable after a
crash. Refused when another account was created after the migration or a base migration has been applied since (then
restore the step-0 backup from `DATA_DIR/migration/` instead, [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) §8). Only **after**
the page says «تم التراجع», deploy R1-a again and remove the variable. **Never deploy R1-a over a migrated directory**:
R1-a does not know the multi-user layout; since the review it finds the tombstone and **refuses to start** («MedLevo
failed to start: … file is not a database»; the deploy fails, nothing is written) — redeploy the latest release, then
roll back in this order. (Before the fix it created an empty `medlevo.sqlite`, offered first-run setup and backed that
empty database up every night.) A refused boot-time rollback after a complete migration (another account, a later base
migration) shows «توقفت الترقية» with the reason, says the data is in user #1's vault and that removing
`MEDLEVO_OWNER_MIGRATION` lets the app start again. One migration or rollback runs at a time per process: the page
re-checks its state after the password check, so a double tap on «ابدأ» / «أعد المحاولة» / «تراجع» starts one thing
(review fix — two runners, or a run and a rollback, could work on the directory at once).

**After the migration**: the R1-a app on each device keeps working for user #1 (an old client without
`x-medlevo-client` is accepted only for user #1 — every other account gets 426 `CLIENT_TOO_OLD`) and shows «تحديث»;
after the update, the app claims the device's R1-a local database and keys **in place** for user #1 (its unsent outbox
is pushed once under user #1's session) and keeps every other account in its own `medlevo:<id>` database and
`<id>:`-prefixed keys (`apps/web/src/lib/userStorage.ts`, `localdb.ts`; docs/modules/tenancy.md «Step 3»).

**Tested** (`apps/server/test/tenancy/owner-migration.test.ts`, `maintenance.test.ts`, `client-gate.test.ts`, on a copy
of a realistic R1-a data directory built by `test/tenancy/legacy-fixture.ts`: sources, processed pages, ink on two
layers, notes, cards with review history, an exam in progress, a recording, backups, sessions on three devices and a
queued outbox): byte-for-byte vault, user #1 verbatim, old password and recovery code, sessions, cursors and epoch,
outbox replayed exactly once, a crash at each of 18 points and `SIGKILL` of the CLI at 3 points and at growing delays,
each resumed to the same end state, refusals, rollback and a crash inside it, and the real `src/index.ts` going from the
page to the app on the same port. **Release verification (2026-10-21):** the real R1-a release (`d0c8ab4`) on such a
data directory → this build's page → user #1 → rollback to the real R1-a, 38 / 38 checks; and the page's forms driven
in headless Chromium (phone and desktop). That found the page sent with `Referrer-Policy: no-referrer`, under which a
browser posts the form with `Origin: null` and the origin check refused «ابدأ الترقية» — now `same-origin`
(`test/tenancy/maintenance-form.r1b.test.ts`). **Not run**: Render, R2, a phone or iPad, Safari, an installed R1-a PWA
updating itself.

## 7. What was exercised here, and what was not

`apps/server/test/deploy/tls-proxy.test.ts` (run by `npm test -w @medlevo/server`; skipped with a reason when `openssl`
is missing) generates a self-signed certificate at test time, starts the **real entry point** (`src/index.ts`,
`NODE_ENV=production`, migrations, static SPA) twice, and puts a TLS-terminating Node reverse proxy in front that
overwrites `X-Forwarded-For` / `X-Forwarded-Proto` like the nginx block above. Over https it checks:

* `MEDLEVO_TRUST_PROXY=true`: `setup_token_required`; setup without / with a wrong token → 403; the one-time token from
  the server log → 200; the session cookie `Secure; HttpOnly; SameSite=Strict; Path=/`; HSTS; the API CSP; the SPA
  served; the session records the client address from `X-Forwarded-For`; a second setup refused; a mutation without
  the CSRF header, with a foreign Origin, with the `http://` origin, or with `Sec-Fetch-Site: cross-site` → 403, the
  exact https origin → 200; the login cookie is Secure.
* `MEDLEVO_TRUST_PROXY=false`: `X-Forwarded-For` is ignored (the proxy's loopback address is recorded); a chosen
  `MEDLEVO_SETUP_TOKEN` is required, never printed, and accepted.

**Not exercised**: a real host, a public certificate (ACME), nginx / Caddy themselves, HTTP/2 or HTTP/3 at the proxy,
a browser's handling of the Secure cookie over the network, and a real upgrade between two released versions (the
migration runner's refusal paths are unit-tested in `apps/server/test/migrations.test.ts`; the restore path in
`apps/server/test/acceptance/g7-ac30.test.ts`).

## 8. Platform hosting from a phone: Render + Cloudflare R2 (PL-0)

The owner has no computer, so the supported hosted setup is operable from a phone or tablet browser: GitHub holds the
code, **Render** builds the root `Dockerfile` and runs it with a persistent disk (blueprint `render.yaml`), and
**Cloudflare R2** keeps encrypted off-site backups. The Arabic, step-by-step guide is
[`DEPLOY_PHONE_AR.md`](DEPLOY_PHONE_AR.md); prices there were read from the providers' public pages on 2026-10-20.
This section is the technical record.

### 8.1 The image (`Dockerfile`, `.dockerignore`, `deploy/docker/*`)

| choice | why |
|---|---|
| `node:22-bookworm-slim` | Node ≥ 22.13 for `node:sqlite`; Debian bookworm ships poppler and a GUI-less LibreOffice as maintained packages |
| three stages: build → deps → runtime | the runtime has only the server's and the shared package's **production** dependencies (no Vite, Vitest, TypeScript, React, Playwright) plus the built PWA; prebuilt musl binaries are removed (never loaded on glibc) |
| `poppler-utils`, `libreoffice-writer-nogui`, `libreoffice-impress-nogui` | page renders for OCR and figure crops (`pdftoppm`); `.doc` / `.docx` → PDF and PPTX display copies, Word → PDF exports. No GUI, no Calc / Draw / Base front-ends, no Java |
| `fonts-noto-core`, `fonts-liberation2`, `fonts-crosextra-carlito` | Arabic in LibreOffice output and exports (Noto Naskh / Kufi / Sans Arabic); metric-compatible Arial / Times and Calibri so Word layouts keep their line breaks. The web reader ships its own fonts |
| `tini` as PID 1 | forwards SIGTERM (graceful stop: running jobs are re-queued) and reaps LibreOffice / poppler children |
| non-root | the server runs as `node` (uid 1000). The entrypoint runs as root only to create `MEDLEVO_DATA_DIR` and hand it (and the disk root) to `node` — a persistent disk can be mounted root-owned — then drops privileges with `setpriv` for good |
| `node --import tsx src/index.ts` | the same entry point as `npm start`, without npm or a tsx parent process between tini and the server |
| `HEALTHCHECK` on `/api/health` | for `docker run`; Render uses the blueprint's `healthCheckPath` |
| `ENV MEDLEVO_HOST=0.0.0.0 MEDLEVO_PORT=10000 MEDLEVO_DATA_DIR=/var/data/medlevo` | Render routes to port 10000 by default; inside a container the app must listen on every interface, so the first-run setup token is always required |

Measured here (Docker 29 in this container, 2026-10-20): 1.27 GB on disk, 332 MB compressed; the largest parts are
LibreOffice (≈ 210 MB), `node_modules` (≈ 241 MB: pdf.js, its optional `@napi-rs/canvas`, tesseract.js and its eng+ara
models, pdf-lib, the Anthropic SDK, esbuild for tsx) and the Noto fonts (≈ 42 MB).

### 8.2 Proxy trust on Render — what is actually correct, and why

What Render and Cloudflare publish (read 2026-10-20): every request to a Render web service passes through Cloudflare and
then Render's load balancers; Render tells apps to read the client address from `X-Forwarded-For` and to trust one
proxy hop (Render article «How Render handles DDoS attacks», 2026-04-01). Cloudflare documents that
`CF-Connecting-IP` carries the address of the client that connected to Cloudflare and recommends it over
`X-Forwarded-For`, to which Cloudflare **appends** (developers.cloudflare.com, «Cloudflare HTTP headers»). A public
third-party test on Render (github.com/johnbeynon/header-test) observed `X-Forwarded-For: <client-supplied>, <client>,
<Cloudflare edge>, <Render LB>`, and Cloudflare refusing a request that already carries `CF-Connecting-IP`.

Consequences:

* `MEDLEVO_TRUST_PROXY=true` (left-most entry) would let any client choose its address — and with it its login rate-limit
  bucket and the address the session list shows. Not used on Render.
* A hop count alone depends on how many proxies append, which Render does not document (the test above saw three).
  Too small a count is safe but makes every client share one address; too large a count is spoofable.
* **Chosen for Render:** `MEDLEVO_TRUST_PROXY=1` + `MEDLEVO_CLIENT_IP_HEADER=cf-connecting-ip`. The app takes the
  address from `CF-Connecting-IP` (set by Cloudflare at the edge, one address). If the header is ever missing or
  malformed, the fallback is the right-most `X-Forwarded-For` entry — written by Render's own proxy, never by the
  client — so the worst case is a shared bucket, never a client-chosen one. A Render web service is reachable only
  through Render's proxy, which is what makes trusting the TCP peer acceptable.
* Residual risk, stated plainly: this relies on Render keeping Cloudflare in front (Render's own article says it does).
  Were a request ever to reach the service without Cloudflare, a client-sent `CF-Connecting-IP` would be believed.
  Not verified on Render itself (no account here). The same holds for another service of the same Render workspace
  reaching this one over Render's private network (it connects to the container directly, as a trusted hop): run no
  other service in that workspace, or set `MEDLEVO_TRUST_PROXY` to Render's load-balancer ranges once they are known.

Tests (`apps/server/test/deploy/client-ip.test.ts`): five failed logins from one client, each with a different forged
`X-Forwarded-For` head, are followed by a 429 for the sixth; every attempt is recorded under the client's real address;
a second client is not affected; the session lists the real address; the hop-count and address-list forms ignore the
forged head too; a peer outside the address list cannot use the header; `true` keeps today's behaviour for the
nginx / Caddy setup above (`tls-proxy.test.ts` still passes unchanged).

### 8.3 Origin, setup token, port

* An unset `MEDLEVO_ORIGIN` (the blueprint leaves it unset) or `MEDLEVO_ORIGIN=auto` → the address Render gives the
  service, `RENDER_EXTERNAL_URL` (Render docs: «the service's full onrender.com URL»). An https origin turns on Secure
  cookies and HSTS. With a custom domain, add `MEDLEVO_ORIGIN` in Render → Environment with the exact address (the
  onrender.com one may follow, comma-separated). Tests: `apps/server/test/deploy/paas-config.test.ts`.
* **The blueprint pins nothing the owner edits** (review fix, 2026-10-21). Render documents that a Blueprint sync — by
  default every push that changes `render.yaml` — overwrites dashboard edits of any variable the Blueprint defines and
  keeps the ones it does not define. `render.yaml` therefore does not define `MEDLEVO_DATA_DIR`, `MEDLEVO_ORIGIN`,
  `MEDLEVO_TIMEZONE`, `MEDLEVO_BACKUP_SCHEDULE` or `MEDLEVO_BACKUP_KEEP_*`; their defaults come from the image
  (`Dockerfile` ENV: `/var/data/medlevo`, `Asia/Baghdad`) and `config.ts` (03:15, 7 / 4 / 1). Before the fix, the
  restore switch (`MEDLEVO_DATA_DIR` set in the dashboard) was undone by the next release that touched `render.yaml`,
  silently moving the server back to the pre-restore directory. Test: `apps/server/test/deploy/render-blueprint.test.ts`.
* `MEDLEVO_SETUP_TOKEN` is generated by Render (`generateValue: true`); the owner copies it from Render → Environment
  once, when creating the account.

### 8.4 Disk layout and restore

The disk is mounted at `/var/data`; the data directory is `/var/data/medlevo`. The mount point is deliberately the
**parent** of the data directory: a restore from the off-site copy (`medlevo-restore-offsite --latest` in the Render
Shell, [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) §6) writes a new directory **beside** the live data on the same disk,
and the switch is one variable, `MEDLEVO_DATA_DIR`, **added** in Render → Environment (Render redeploys; the blueprint
does not define it, so a Blueprint sync never undoes it — §8.3). Anything outside the
disk is wiped by every deploy, so the restore command refuses a target on another filesystem. Render also takes its own
daily disk snapshots (kept ≥ 7 days, per Render's docs) — a second, provider-side safety net, not a replacement for the
encrypted off-site copy.

**Files in R2 too (P1-T1 step 2, optional).** With `MEDLEVO_BLOB_STORE=r2` the server copies every uploaded or
generated file to the same bucket under `<MEDLEVO_R2_PREFIX>blobs/aa/bb/<sha256>.mlenc`, encrypted on the server first,
and fetches a file back (decrypted, its sha256 checked) when the disk copy is missing — e.g. on a new disk. The disk
still keeps every file in this step (no eviction yet), so the disk size is unchanged; the gain is a second copy outside
Render. Verified only against the signature-checking S3 fake (`apps/server/test/tenancy/blob-r2.test.ts`), **not**
against Cloudflare R2.

### 8.5 What was verified, and what was not

Verified **in this container** with Docker (the committed `Dockerfile` built unmodified by `docker build`, except that
this sandbox needs its TLS-intercepting proxy's CA during `npm ci`, injected through a build context for the local
build only):

* the image starts as `tini` → entrypoint → `node` (uid 1000) on a **root-owned** volume, which it hands to `node`;
  `/api/health` is healthy and Docker's HEALTHCHECK reports «healthy»;
* first-run setup: `setup_token_required`, 403 without the token, 200 with it;
* uploads processed inside the image: a text PDF, a scanned PDF (pdftoppm + OCR: 1 OCR page), a PPTX (LibreOffice
  display copy, 3/3 pages); the server reports poppler, LibreOffice and tesseract available;
* graceful stop (SIGTERM through tini: «shutting down» logged), start again: the owner, the library and every processed
  version are still there;
* a Render-like environment (`MEDLEVO_ORIGIN=auto` + `RENDER_EXTERNAL_URL`, `MEDLEVO_TRUST_PROXY=1`,
  `MEDLEVO_CLIENT_IP_HEADER=cf-connecting-ip`): Secure cookie, the session records the `CF-Connecting-IP` address
  despite a forged `X-Forwarded-For` head, a foreign Origin is refused;
* «نسخ احتياطي الآن» → local backup → restore verification → encrypted upload to the **test-only S3 fake** (which checks
  every SigV4 signature) → `medlevo-restore-offsite --latest` from a shell **without** the service environment (it takes
  MedLevo's variables from the running server) → every check PASS → a new container started on the restored directory:
  old sessions revoked, data present.

**Not run** (no accounts / no device here): Render itself (build, disk mount ownership, Shell, `RENDER_EXTERNAL_URL`,
the proxy chain), Cloudflare R2 itself, a phone or iPad browser, a custom domain. CI can build and smoke-test the image
on GitHub's runners: Actions → CI → «Run workflow» → `docker` = true (`.github/workflows/ci.yml`).
