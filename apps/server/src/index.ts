// Server boot: config → database + migrations → app → jobs → listen; graceful shutdown.
import { buildApp } from './app';
import { ConfigError, loadConfig, loadDotEnv } from './config';
import { openDb } from './db/db';
import { migrate, MigrationError } from './db/migrate';
import { mkdirSync } from 'node:fs';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const db = openDb(config.dbPath);
  const migrations = migrate(db);

  const app = await buildApp({ config, overrides: { db } });
  if (migrations.applied.length) app.log.info({ applied: migrations.applied }, 'migrations applied');
  await app.ready();
  app.ctx.jobs.start();
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { aiConfigured: app.ctx.ai.configured, externalFetch: config.allowExternalFetch, env: config.env },
    'MedLevo server ready',
  );

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
  if (e instanceof ConfigError || e instanceof MigrationError) {
    process.stderr.write(`MedLevo failed to start: ${e.message}\n`);
  } else {
    process.stderr.write(`MedLevo failed to start: ${(e as Error)?.stack ?? String(e)}\n`);
  }
  process.exit(1);
});
