# Deployment (§49, §61)

MedLevo is one Node.js process (API + the built web app) with an embedded SQLite database and a private file store
under one data directory. It is built for **one owner** on a machine the owner controls. This page is the production
setup: reverse proxy and TLS, the environment, the first-run setup token, backups on a schedule, and the update plan for
sources, models and the database schema. The setup below is **exercised by an automated test**
(`apps/server/test/deploy/tls-proxy.test.ts`, §7) — on this container, not on a real host or a public certificate.

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
  when nothing but the proxy can reach the app — keep `MEDLEVO_HOST=127.0.0.1` (or a firewall);
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

Caddy: `medlevo.example.org { reverse_proxy 127.0.0.1:8787 { header_up X-Forwarded-For {remote_host} } request_body { max_size 210MB } }`.

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

Backups are consistent while the server runs (SQLite `VACUUM INTO` + the content-addressed file store). Archives are
**not encrypted**; the offline copy on a device is not a backup. Full procedure: [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md).

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
