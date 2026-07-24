import { initObservability, getLogger, shutdownObservability } from '@platform/observability';
import { FileTenantConfigProvider } from '@platform/config';
import type { ISessionStore } from '@platform/core';
import {
  InMemoryCallRepository,
  InMemoryCallSummaryRepository,
  InMemoryLeadRepository,
  InMemorySessionStore,
  InMemoryTranscriptRepository,
  PostgresCallRepository,
  PostgresCallSummaryRepository,
  PostgresLeadRepository,
  PostgresTranscriptRepository,
  RedisSessionStore,
  runMigrations,
} from '@platform/data';
import { loadEnv } from './env.js';
import { createServer } from './server.js';
import type { Repositories } from './call-session.js';

const logger = getLogger({ component: 'main' });

async function buildPersistence(env: ReturnType<typeof loadEnv>): Promise<{
  repositories: Repositories;
  sessionStore: ISessionStore;
  close: () => Promise<void>;
}> {
  if (env.persistence === 'memory') {
    logger.info('using in-memory persistence (calls/leads/summaries are not durable)');
    return {
      repositories: {
        calls: new InMemoryCallRepository(),
        transcripts: new InMemoryTranscriptRepository(),
        leads: new InMemoryLeadRepository(),
        summaries: new InMemoryCallSummaryRepository(),
      },
      sessionStore: new InMemorySessionStore(),
      close: async () => {},
    };
  }

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: env.databaseUrl });
  await runMigrations(pool);
  logger.info('postgres migrations applied');

  let sessionStore: ISessionStore;
  let closeRedis = async (): Promise<void> => {};
  if (env.redisUrl) {
    const { createClient } = await import('redis');
    const client = createClient({ url: env.redisUrl });
    await client.connect();
    sessionStore = new RedisSessionStore(client);
    closeRedis = async () => void (await client.quit());
    logger.info('redis session store connected');
  } else {
    logger.warn('REDIS_URL not set; using in-memory session store (sessions lost on restart)');
    sessionStore = new InMemorySessionStore();
  }

  return {
    repositories: {
      calls: new PostgresCallRepository(pool),
      transcripts: new PostgresTranscriptRepository(pool),
      leads: new PostgresLeadRepository(pool),
      summaries: new PostgresCallSummaryRepository(pool),
    },
    sessionStore,
    close: async () => {
      await closeRedis();
      await pool.end();
    },
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  initObservability({ serviceName: 'voice-agent', serviceVersion: '0.1.0' });

  const tenants = new FileTenantConfigProvider(env.tenantConfigDir);
  const tenantIds = await tenants.listTenantIds();
  logger.info({ tenantIds, simulation: env.simulation, persistence: env.persistence }, 'tenants loaded');

  const persistence = await buildPersistence(env);
  const server = createServer({
    env,
    tenants,
    repositories: persistence.repositories,
    sessionStore: persistence.sessionStore,
  });

  server.listen(env.port, () => {
    logger.info({ port: env.port, publicHost: env.publicHost }, 'voice-agent listening');
  });

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await persistence.close();
    await shutdownObservability();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
