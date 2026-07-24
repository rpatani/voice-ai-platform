/**
 * Postgres schema, applied idempotently at startup by `runMigrations`.
 * Every table is tenant-scoped; all lookups go through (tenant_id, ...) so
 * indexes lead with tenant_id.
 *
 * Migrations are ordered SQL statements keyed by version. To evolve the
 * schema, append a new entry - never edit an applied one.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE IF NOT EXISTS calls (
        call_id      TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        from_number  TEXT NOT NULL,
        to_number    TEXT NOT NULL,
        started_at   TIMESTAMPTZ NOT NULL,
        ended_at     TIMESTAMPTZ,
        outcome      TEXT NOT NULL DEFAULT 'in_progress',
        booking_id   TEXT,
        PRIMARY KEY (tenant_id, call_id)
      );
      CREATE INDEX IF NOT EXISTS idx_calls_tenant_started ON calls (tenant_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS transcript_turns (
        tenant_id   TEXT NOT NULL,
        call_id     TEXT NOT NULL,
        turn_index  INTEGER NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text        TEXT NOT NULL,
        ts          TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, call_id, turn_index)
      );

      CREATE TABLE IF NOT EXISTS leads (
        lead_id        TEXT NOT NULL,
        tenant_id      TEXT NOT NULL,
        call_id        TEXT NOT NULL,
        caller_name    TEXT,
        phone_number   TEXT,
        service_need   TEXT,
        preferred_time TEXT,
        created_at     TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, lead_id)
      );
      CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads (tenant_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS call_summaries (
        tenant_id   TEXT NOT NULL,
        call_id     TEXT NOT NULL,
        summary     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, call_id)
      );
    `,
  },
];
