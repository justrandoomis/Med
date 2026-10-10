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

* Run `npm run backup -- --out <another disk>` daily (cron / systemd timer). Keep several generations.
* Run `npm run restore:verify -- <latest archive>` weekly, or use «تحقّق» in the app.
* Copy archives off the machine. They contain your whole study record, so treat them as private. Archives are not
  encrypted. Use disk or transport encryption if they leave your control.

## 5. Known limits

* The API backup job runs `VACUUM INTO` on the server's event loop. On a large database the server pauses for that
  moment (the file copy afterwards is streamed). The CLI has no such effect on the running server.
* If a verification process is killed, its temporary `.medlevo-restore-*` directory can remain in the temp directory
  (or `--work-dir`). Delete it by hand.
* No incremental or encrypted backups. No restore "into" a running server: restoring always means starting the
  server on the new directory.
