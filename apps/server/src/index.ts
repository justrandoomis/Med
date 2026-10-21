// Server boot: config → (owner migration / maintenance page when needed) → app → jobs → listen; graceful shutdown.
//
// P1-T1 step 3: a data directory that is not a finished multi-user layout never reaches the app. planBoot decides:
// single-owner data (medlevo.sqlite) → the maintenance page /api/maintenance waits for the owner (or migrates at once
// with MEDLEVO_OWNER_MIGRATION=apply); an unfinished migration journal → resumed at once; a rollback → done at once.
// The maintenance server answers on the same port (health 200, so a platform's deploy goes live and the owner can
// reach the page); when the migration completes it closes and the app starts in the same process.
import { buildApp } from './app';
import { ConfigError, loadConfig, loadDotEnv } from './config';
import { MigrationError } from './db/migrate';
import { DataDirRefusedError } from './system/layout';
import { planBoot, startMaintenance } from './system/maintenance';
import { clearServerLock, recordFirstBoot, writeServerLock } from './system/ownerMigration';
import { rowCounts } from './modules/data/backup';
import { mkdirSync } from 'node:fs';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  writeServerLock(config.dataDir, 'maintenance');
  process.once('exit', () => clearServerLock(config.dataDir));

  const plan = planBoot(config);
  if (plan.kind === 'maintenance') {
    const m = await startMaintenance({ config, plan });
    await m.app.listen({ host: config.host, port: config.port });
    m.app.log.warn({ state: plan.state, start: plan.start }, 'MedLevo is in maintenance (owner migration): open /api/maintenance');
    let stopping = false;
    const stopMaintenance = (signal: string) => {
      if (stopping) return;
      stopping = true;
      m.app.log.info({ signal }, 'shutting down (maintenance)');
      void m.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', () => stopMaintenance('SIGINT'));
    process.once('SIGTERM', () => stopMaintenance('SIGTERM'));
    await m.finished;
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    await m.close();
  }

  // the system DB, the boot guard and the vault pool are set up by the context (P1-T1); vaults migrate when opened
  writeServerLock(config.dataDir, 'app');
  const app = await buildApp({ config });
  await app.ready();
  app.ctx.jobs.start();
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { aiConfigured: app.ctx.ai.configured, externalFetch: config.allowExternalFetch, env: config.env },
    'MedLevo server ready',
  );
  // ADR-0003 §5 step 11: after the first boot that followed the owner migration, record the vault's checksum and
  // per-table row counts again (once; a no-op on every later boot)
  try {
    const line = await recordFirstBoot({
      dataDir: config.dataDir,
      vaultPath: (id) => app.ctx.pool.pathOf('vault', id),
      checkpoint: (id) =>
        app.ctx.binding.run({ kind: 'vault', vaultId: id, viewer: null }, () => {
          app.ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          return rowCounts(app.ctx.db);
        }),
    });
    if (line) app.log.info({ sha256: line.sha256, tablesChangedByFirstBoot: line.tables_changed_by_first_boot }, 'owner migration: first boot recorded');
  } catch (e) {
    app.log.error({ err: e }, 'owner migration: could not record the first boot (the data is unaffected)');
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close(); // stops jobs (re-queues running ones) and closes the database
      process.exit(0);
    } catch (e) {
      app.log.error({ err: e }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError || e instanceof MigrationError || e instanceof DataDirRefusedError) {
    process.stderr.write(`MedLevo failed to start: ${e.message}\n`);
  } else {
    process.stderr.write(`MedLevo failed to start: ${(e as Error)?.stack ?? String(e)}\n`);
  }
  process.exit(1);
});
