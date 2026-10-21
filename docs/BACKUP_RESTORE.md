# Backup & restore (§49, AC-30)

MedLevo keeps everything you wrote (notes, ink, highlights, answers, review history, Study Books, settings) in one
SQLite database plus a content-addressed file store under `MEDLEVO_DATA_DIR`. A **backup** is one `.tar.gz` archive
with a consistent snapshot of both. A **restore** puts that archive into a new, empty directory that the server is
then started on. A restore never writes over existing data.

> The offline copy on a phone or tablet (the Download Manager) is **not** a backup. It is a temporary working copy
> that the browser can delete. Make backups on the server.

## 1. Making a backup

### From the command line (recommended for scheduled backups)

```bash
npm run backup                                # writes to <MEDLEVO_DATA_DIR>/backups/
npm run backup -- --out /mnt/usb/medlevo      # somewhere else (a relative path is relative to where you ran npm)
npm run backup -- --data-dir /srv/medlevo/data
```

* This is safe while the server is running. The database is copied with SQLite `VACUUM INTO`, which gives a
  consistent snapshot without stopping writers. The stored files are content-addressed and never change in place.
* Output: `medlevo-backup-YYYYMMDD-HHMMSSZ-<id>.tar.gz` plus a `.sha256` sidecar (`sha256sum -c` checks it).
  The archive is written as `.partial` first and renamed only when complete, so a half-written archive never looks
  finished.
* Exit codes: `0` completed · `3` completed **with warnings** (e.g. a file the database refers to was missing or
  damaged on disk; the archive is still written and the warning is in `manifest.json`) · `1` failed (nothing kept)
  · `2` usage error / no database.
* The backup is also recorded in the database (`data_backup`, origin `cli`), so it shows in the app under
  «بياناتك» → «النسخ الاحتياطي».

### From the app

«بياناتك» (`/offline`) → «النسخ الاحتياطي» → «أنشئ نسخة احتياطية الآن». This starts a background job
(`POST /api/data/backups`). The list shows the real status, size and sha256. «نزّل» downloads the archive through an
authenticated, audited link (`GET /api/data/backups/:id/download`). «تحقّق» runs the same restore verification as
the CLI below, on the server, in a separate temporary directory. Only one backup job runs at a time (409 otherwise).
Rate limits: 3 backups and 3 verifications per 10 minutes.

### What is in the archive

```
medlevo-backup/manifest.json       format medlevo-backup-1: backup id, app version, created_at,
                                   db {sha256, size, applied migrations, row count per table, sync head seq, epoch},
                                   files [{path, file_id, sha256, size}], files_missing, excluded
medlevo-backup/medlevo.sqlite      the database snapshot
medlevo-backup/files/aa/bb/<sha256> every stored file a database row refers to (originals, converted PDFs,
                                   page renders, figure crops)
```

**Never included:**

* `secret.key`, the server's signing key. A restored server generates a new one. Old signed file links simply
  expire.
* Environment variables and `.env`, including `ANTHROPIC_API_KEY` and any other key. Configure them again on the
  restored server.
* `tmp/`, OCR model caches (`tessdata*`), earlier backups (`backups/`), and files that no database row refers to.
* As a safety net, `owner_setting` rows whose key looks like a secret (api key / token / password / credential), or
  whose value looks like an Anthropic key or a private key, are removed from the snapshot with a warning. No module
  stores secrets there today. The test suite checks that the setup token, a planted API key, `secret.key` and
  `.env` never appear in an archive.

## 2. Verifying a backup (do this — a backup you have not restored is a hope)

```bash
npm run restore:verify -- /path/to/medlevo-backup-….tar.gz
```

This extracts the archive into a **separate temporary directory** (`--work-dir` sets its parent) and checks:

| check | what it proves |
|---|---|
| `archive` | safe extraction: no absolute paths, no `..`, no symlinks/hardlinks/devices, no duplicate entries, valid tar checksums, not truncated, entry-count / total-size / compression-ratio limits measured while inflating |
| `manifest` | `manifest.json` is present and valid (format `medlevo-backup-1`) |
| `layout` | every archive entry is listed in the manifest (nothing smuggled in) |
| `database_hash` | the database's sha256 matches the manifest |
| `file_hashes` | each file's size and sha256 match |
| `integrity_check` | `PRAGMA integrity_check` = ok |
| `foreign_keys` | `PRAGMA foreign_key_check` is empty |
| `migrations` | every applied migration is known to this build with identical content. A backup from a **newer** build fails (update the server first). A backup from an older build passes, and the newer migrations are applied when the server starts |
| `row_counts` | row count per table matches the manifest |
| `files_complete` | every file the database refers to is in the archive. A file that was already missing or damaged when the backup was made (listed in `files_missing`) fails this check, and the report says how to proceed: `--accept-missing-files` (below) |
| `fts` | full-text index structure, docsize/rowid mapping, and real `MATCH` probes on restored text |
| `sources_versions_pages`, `annotations_targets`, `questions_occurrences`, `links`, `sessions`, `learning` | relational checks: current versions belong to their source, processed versions have pages, regions are on pages of their version, every ink/note has an existing target, questions have occurrences, attempts are on a version of their question, evidence points to a matching region/version/source, sessions are on a version of their source, review events belong to existing cards |
| `boot` | the real app boots on the restored directory: `/api/health` is healthy, counts match, and protected routes ask for sign-in (`--no-boot` skips this) |

The temporary directory is deleted afterwards unless you pass `--keep`. Other options: `--json <file>` (writes the
report), `--max-gb <n>` (largest uncompressed size accepted, default 64), `--accept-missing-files` (see below). Exit
codes: `0` every check passed · `1` a check failed (nothing restored) · `2` usage error or a refused target.

**A backup made with warnings (`files_missing`).** If a file was already missing or damaged on the server's disk when
the backup was made, the backup is marked «completed with warnings» and `files_complete` fails, so by default nothing
is restored. Your writing and everything else in that archive are still intact. To restore them anyway, add
`--accept-missing-files`. The check then passes **only** if every absent file is one the manifest already listed as
missing or damaged at backup time. Anything else missing or damaged still fails. The report names every file restored
without its content (those files will not open). Bytes of a file that was damaged at backup time are in the archive,
but they are never placed in the restored file store.

## 3. Restoring

```bash
# from the repository root: note the SECOND `--` (the root script forwards to the server workspace, and npm
# would otherwise take --target for itself)
npm run restore:verify -- /path/to/backup.tar.gz -- --target /srv/medlevo/data-restored

# or from apps/server: one `--`
cd apps/server && npm run restore:verify -- /path/to/backup.tar.gz --target /srv/medlevo/data-restored
```

* `--target` must **not exist or be empty**, and it may not be the live data directory (refused with exit code `2`,
  and nothing is touched). The comparison uses real paths, so a symlink to the live directory is refused too. There is
  no "overwrite" option.
* The archive is first fully verified (all checks above) in a staging directory next to the target. Only if every
  check passes is the staging directory renamed into the target. A failed check restores nothing.
* On the restored copy, before it is moved into place:
  * a **new sync epoch** is started (`data_server_epoch`, reason `restore`, with the backup id and time and the
    sync position of the backup);
  * **every session is revoked**, so all devices must sign in again;
  * backup jobs that were running in the snapshot are marked failed. The exception is the backup being restored: the
    API job takes its snapshot while its own row still says «running», so that row is marked completed, with a note
    that its archive is not inside the restored directory;
  * a `restore` entry is added to the change log.
* Then point the server at it: set `MEDLEVO_DATA_DIR=/srv/medlevo/data-restored`, set the environment again
  (`ANTHROPIC_API_KEY`, origin, …) and start the server. Keep the old directory until you are satisfied.

### What happens on the devices after a restore

Phones and tablets may hold writing the backup does not have (made after the backup was taken). The sync protocol
handles this without losing it:

1. The pull answer carries `server_epoch`, `epoch_base_seq` (the sync position of the backup) and `head_seq`.
   Every push carries the epoch the device last pulled from (`server_epoch`). A server whose epoch is different refuses
   the whole push untouched (409, `details.server_epoch_changed`), so a write made while the server was being restored
   is never applied on top of revisions the restored data lacks. Such a write would otherwise come back as a false
   «conflict» copy, or a re-sent write would be applied twice.
2. When a device sees a new epoch (on that refusal or on its next pull), or its cursor is above the server's head, it
   does **not** trust its pull cursor. Every write this device sent that the old server acknowledged **after** the
   backup point (`ackSeq` > `epoch_base_seq`) is queued again as a new operation (new op id, linked with `retryOf`).
   Writes still waiting for the same rows are moved **after** those copies, so each row's history reaches the
   restored server in order. Then the device pulls again from position 0 and pushes. The appliers never overwrite a
   row that still has local operations, so the restored server's older copy never replaces newer local writing.
   Only a real change on both sides follows the normal conflict rules (both copies kept).
3. The Download Manager shows a notice («استُعيدت بيانات الخادم من نسخة احتياطية.») with when it was detected and
   how many writes were sent again.

Limits: a device re-sends only writes that are still in its outbox history (synced ops are kept for 7 days) and that
it sent with this version of the app (older acknowledgements have no `ackSeq`). Writing that **another** device made
after the backup comes back only if that device syncs again. The server cannot know about it. If the server is
restored **twice** while a device stays offline, the device compares its acknowledgements only with the latest
restore point. Writes the first server acknowledged after the first backup can then be missed when their position
is below the second restore point (the two servers numbered their change feeds independently). A conflict copy that only the
old server created (`conflict_kept_both`) is not re-created on the restored server. It stays on the device that
pulled it.

## 4. Suggested routine

* Hosted (Render): configure the off-site backup (§6). It runs daily, verifies each archive before uploading it,
  encrypts it, keeps 7 daily + 4 weekly copies in Cloudflare R2, and the Control Center shows the last result.
* Self-hosted: run `npm run backup -- --out <another disk>` daily (cron / systemd timer) and keep several generations,
  or configure §6 there too.
* Run `npm run restore:verify -- <latest archive>` weekly, or use «تحقّق» in the app (the off-site run does this for
  every archive it uploads).
* Copy archives off the machine. They contain your whole study record, so treat them as private. **Local** archives are
  not encrypted; the off-site copies of §6 are.

## 5. Known limits

* The API backup job runs `VACUUM INTO` on the server's event loop. On a large database the server pauses for that
  moment (the file copy afterwards is streamed). The CLI has no such effect on the running server.
* If a verification process is killed, its temporary `.medlevo-restore-*` directory can remain in the temp directory
  (or `--work-dir`). Delete it by hand.
* No incremental backups: every run is a full archive (R2 storage is cheap; see the guide's cost table). Local
  archives are not encrypted (§6 encrypts the off-site copies). No restore "into" a running server: restoring always
  means starting the server on the new directory.

## 6. Off-site backups to Cloudflare R2 (PL-0)

For a server you cannot touch (Render, managed from a phone) the server itself keeps an **encrypted copy outside the
host**. Setup from a phone: [`DEPLOY_PHONE_AR.md`](DEPLOY_PHONE_AR.md). Code: `apps/server/src/modules/data/offsite*.ts`,
`apps/server/src/lib/objectstore/*`, CLI `apps/server/src/cli/restore-offsite.ts`.

### What one run does

1. **Local backup** — the same archive as «أنشئ نسخة احتياطية الآن» (it appears in «بياناتك» → «النسخ الاحتياطي»).
2. **Verification** — the same checks as `npm run restore:verify` (§2), including booting the app on the restored copy, in
   `DATA_DIR/tmp`. A failed check stops the run: **nothing unverified is uploaded**. A backup made with warnings
   (`files_missing`) is verified with the `--accept-missing-files` rule, and the warning is shown with the run.
3. **Encryption on the server**, streamed (constant memory): format `MLVENC01` — a 64-byte header (magic, version, frame
   size, key fingerprint, random 32-byte salt) then 1 MiB frames, each AES-256-GCM-sealed with its own tag. The file key
   is HKDF-SHA256(master key, salt); frame nonces are a counter plus a «last frame» flag (the STREAM construction), and
   the header is authenticated with every frame. A changed, reordered, dropped, duplicated, appended or truncated frame —
   even a cut exactly at a frame boundary — fails authentication, and nothing is used.
4. **Upload** to the bucket under `<prefix>backups/<archive name>.mlenc` (S3 API with Signature V4): one PUT for small
   archives, otherwise a multipart upload with equal 16 MiB parts (R2's rule: every part but the last the same size,
   ≥ 5 MiB, ≤ 10,000 parts). Each request is retried with backoff on network errors, 5xx, 429 and `SlowDown`; each
   part's ETag is checked against its MD5. **Resume:** the upload id and the salt are stored in `data_offsite_backup`;
   after a failed attempt or a restart the job (3 attempts) re-encrypts the same archive with the same salt — byte-
   identical ciphertext — lists the parts R2 already holds and uploads only the missing ones. If R2 completed the upload but its answer was
   lost, the retry finds no such upload; the object is then accepted only when it is there with exactly the announced
   size (review fix, 2026-10-21 — before, the run was reported failed although the copy was stored). A `HEAD` then
   confirms the stored size. Object metadata holds the key fingerprint, the backup id, the archive's sha256 and the app version
   — never a secret.
5. **Retention**: in R2, the newest backup of each of the last `MEDLEVO_BACKUP_KEEP_DAILY` days (default 7) and of each
   of the last `MEDLEVO_BACKUP_KEEP_WEEKLY` ISO weeks (default 4) stays; older MedLevo objects under the prefix are
   deleted (other objects are never touched; nothing is deleted if the new copy does not show in the listing). On the
   server disk only the newest `MEDLEVO_BACKUP_KEEP_LOCAL` (default 1) archives **made by off-site runs** stay; manual
   and CLI backups are never deleted by it. A run that finally **fails** also cleans up (review fix, 2026-10-21): its
   unfinished multipart upload is aborted, and older off-site-run archives beyond the retention are deleted while its
   own archive (a verified local copy when only the upload failed) and the newest archive whose verification passed stay
   (a run whose verification failed never displaces it) — before, every
   failed run (e.g. one a day with a wrong R2 secret) left a full archive on the disk the live database is on.
   One bucket prefix per server: two servers writing to the same `MEDLEVO_R2_PREFIX` would prune each other's copies.

**Schedule:** `MEDLEVO_BACKUP_SCHEDULE` = `HH:MM` in `MEDLEVO_TIMEZONE` (default `03:15`) or `off`. The scheduler runs
inside the server once it listens; a slot missed while the server was down runs at the next start; a slot with any run
(scheduled or manual, successful or not) does not run again; nothing runs before the owner account exists. A run whose
job is no longer queued or running (a crash or an out-of-memory kill on its last attempt, after which the job queue
fails the job at the next boot) is closed as interrupted on every status read, «نسخ احتياطي الآن» and scheduler tick —
before the review fix (2026-10-21) it stayed «running» for good and blocked every later off-site backup.

**Control Center → «النسخ الاحتياطي خارج الخادم»** (`GET /api/data/offsite`): configured or not (missing settings are
named, never their values), last successful copy (time, encrypted size, result), last attempt and its reason, the next
scheduled run, retention, recent runs, and **«نسخ احتياطي الآن»** (`POST /api/data/offsite/run`; disabled with its reason
when R2 is not configured or a run is in progress; 3 per 10 minutes). «اعرض النسخ المحفوظة في R2»
(`GET /api/data/offsite/remote`) lists the copies, each with its restore command.

### Settings (environment only)

| variable | meaning |
|---|---|
| `MEDLEVO_R2_ACCOUNT_ID` | Cloudflare account id → endpoint `https://<id>.r2.cloudflarestorage.com` |
| `MEDLEVO_R2_ENDPOINT` | instead of the account id: an EU-jurisdiction endpoint or another S3-compatible store (https only) |
| `MEDLEVO_R2_BUCKET` | the bucket (render.yaml: `medlevo-backups`) |
| `MEDLEVO_R2_ACCESS_KEY_ID`, `MEDLEVO_R2_SECRET_ACCESS_KEY` | an R2 API token with **Object Read & Write on this bucket only** (least privilege: no admin, no other buckets) |
| `MEDLEVO_BACKUP_ENCRYPTION_KEY` | 32 random bytes, base64 (Render generates it) or 64 hex characters |
| `MEDLEVO_R2_PREFIX` | key prefix, default `medlevo/` |
| `MEDLEVO_BACKUP_SCHEDULE`, `MEDLEVO_BACKUP_KEEP_DAILY`, `MEDLEVO_BACKUP_KEEP_WEEKLY`, `MEDLEVO_BACKUP_KEEP_LOCAL` | above |

Missing or invalid R2 settings never stop the server (off-site backups are then «غير مُعدّ»); a malformed schedule or
retention number does, with a message naming the variable.

> **The encryption key is the only way to read the off-site copies.** It is never stored in the database, a backup,
> a log or R2 — only its fingerprint is. Lose it and every off-site backup is unreadable: there is no recovery, by
> design. Copy it to a password manager (or print it) the day you deploy. Changing it later is safe for new backups;
> older copies still need the old key (the restore command says which fingerprint an archive needs).

### Restoring from R2 — one command in the Render Shell

```bash
medlevo-restore-offsite --list          # what R2 holds, newest first
medlevo-restore-offsite --latest        # restore the newest copy
medlevo-restore-offsite --key medlevo-backup-20261020-001500Z-ab12cd34.tar.gz
```

It downloads the object (resuming a broken or timed-out download with a Range request for as long as each round brings new bytes; only rounds without progress count as failed attempts), decrypts and authenticates it, runs every
§2 check, and restores into a **new** directory beside the live data on the same disk
(`/var/data/medlevo-restored-<time>` on Render) — never over the live data, never on another disk unless
`--allow-other-disk`. It prints the one setting to add: `MEDLEVO_DATA_DIR=<that directory>` in Render →
Environment (render.yaml deliberately does not define it, so a Blueprint sync never moves the server back to the old
directory — DEPLOYMENT.md §8.3); Render redeploys and the server starts on the restored data (new sync epoch, every session revoked,
devices re-send what the backup lacks, §3). `--verify-only` downloads, decrypts and checks without restoring. If the
Shell session does not carry the service's environment, the command takes MedLevo's own variables from the running
server (PID 1). Run as root, it gives the restored files to the owner of the live data directory. Elsewhere:
`node --import tsx apps/server/src/cli/restore-offsite.ts --latest` from the repository root.

**Why a Shell command and not a button in the app.** A restore replaces everything the owner wrote since the backup.
As a web action it would be one stolen session or one XSS away from wiping recent work, and it would have to swap the
data directory under a running server. In the Shell it needs a second, separate login (the Render account, with its
own 2FA), it never touches the live directory (new directory + one variable), and the running server is never switched
underneath itself. The app shows the exact command with a copy button, which is all a phone needs.

### Tests and honesty

* `apps/server/test/deploy/objectstore-sigv4.test.ts` — the signer reproduces AWS's five published Signature V4 examples.
* `apps/server/test/data/objectstore.test.ts` — encryption round trips at every frame boundary, tamper / reorder /
  truncation / wrong-key refusals; the S3 client against `test/data/fake-s3.ts`, an in-process S3 fake that **verifies
  every request's SigV4 signature, payload hash and clock skew as received**: retries, refusals not retried, resumed
  downloads, multipart upload with a failing part resumed without re-sending stored parts.
* `apps/server/test/data/offsite.test.ts`, `offsite-schedule.test.ts`, `offsite-cli.test.ts` — the whole run, honest
  «not configured» states, retention (remote and local), the schedule (catch-up, one run per slot, DST), restore from
  the fake (verify-only, restore beside the data, wrong key, damaged object), the CLI as a real process, and no secret
  in the API, the database or the bucket.
* Docker: the same flow inside the image (DEPLOYMENT.md §8.5).
* **Not run:** Cloudflare R2 itself, Render's Shell. The fake implements R2's documented multipart rules but is not R2.
