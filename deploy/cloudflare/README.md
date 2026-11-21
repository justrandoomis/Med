# MedLevo on Cloudflare (Workers + Containers + R2)

Live address: **https://medlevo.aliamer59409.workers.dev** (account «Aliamer59409@gmail.com's Account»).

## How it runs

* `wrangler.jsonc` (repository root) + `deploy/cloudflare/worker.ts`: a Worker in front of **one** container instance
  (1 vCPU, 4 GB RAM, 20 GB disk) that runs the same `Dockerfile` Render runs.
* Cloudflare builds the image itself (**Workers Builds**, connected to this GitHub repository). A push to the
  production branch (`cloudflare`) builds and deploys. Build command: none; deploy command: `npx wrangler deploy`.
* The container sleeps after 3 hours without visits. The first visit after that shows «MedLevo يبدأ التشغيل…» for
  about a minute while the data is restored, then the app opens.

## Where the data lives

Cloudflare containers have **no permanent disk** — every start begins with an empty disk. So:

1. While it runs, the server makes an encrypted, verified backup to the R2 bucket `medlevo-backups` every
   10 minutes (`MEDLEVO_BACKUP_INTERVAL_MINUTES`), plus the usual daily copy. Retention keeps the newest, one per day
   (7 days) and one per week (4 weeks).
2. When a container starts on an empty disk, `deploy/docker/medlevo-cloud-boot` restores the newest R2 backup (every
   restore:verify check runs) before the server starts. If the restore fails it **does not start empty** (that
   would back up an empty server over your data); the container retries.

At worst a forced restart (a deploy, a Cloudflare host move) loses the last ≤10 minutes of work. Before a deploy you
can press «نسخ احتياطي الآن» in «مركز التحكم» to lose nothing.

## Settings

Plain values (`wrangler.jsonc` → `vars`): `MEDLEVO_ORIGIN`, `MEDLEVO_R2_BUCKET`, `MEDLEVO_BACKUP_INTERVAL_MINUTES`.

Secrets (`npx wrangler secret put <NAME>`; never in the repository — it is public):

| secret | what |
|---|---|
| `ANTHROPIC_API_KEY` | AI features (explanations, Study Book, generated questions) |
| `MEDLEVO_SETUP_TOKEN` | asked once when creating the owner account |
| `MEDLEVO_BACKUP_ENCRYPTION_KEY` | encrypts the R2 backups — **keep a copy outside Cloudflare**; without it no backup can be read |
| `MEDLEVO_R2_ACCOUNT_ID`, `MEDLEVO_R2_ACCESS_KEY_ID`, `MEDLEVO_R2_SECRET_ACCESS_KEY` | an R2 API token limited to `medlevo-backups` (Object Read & Write) |

Changing a secret takes effect at the next container start.
