import type { Pool } from 'pg';
import type {
  CallOutcome,
  CallRecord,
  CallSummaryRecord,
  ICallRepository,
  ICallSummaryRepository,
  ILeadRepository,
  ITranscriptRepository,
  LeadRecord,
  TranscriptTurn,
} from '@platform/core';
import { withSpan } from '@platform/observability';
import { MIGRATIONS } from './schema.js';

/**
 * Applies all pending migrations inside a transaction, tracked in a
 * `schema_migrations` table. Safe to run on every startup.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  await withSpan('db.runMigrations', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const { rows } = await pool.query<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  });
}

interface CallRow {
  call_id: string;
  tenant_id: string;
  from_number: string;
  to_number: string;
  started_at: Date;
  ended_at: Date | null;
  outcome: string;
  booking_id: string | null;
}

const toCallRecord = (r: CallRow): CallRecord => ({
  callId: r.call_id,
  tenantId: r.tenant_id,
  fromNumber: r.from_number,
  toNumber: r.to_number,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  outcome: r.outcome as CallOutcome,
  bookingId: r.booking_id,
});

export class PostgresCallRepository implements ICallRepository {
  constructor(private readonly pool: Pool) {}

  async create(record: CallRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO calls (call_id, tenant_id, from_number, to_number, started_at, ended_at, outcome, booking_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.callId,
        record.tenantId,
        record.fromNumber,
        record.toNumber,
        record.startedAt,
        record.endedAt,
        record.outcome,
        record.bookingId,
      ],
    );
  }

  async finalize(
    tenantId: string,
    callId: string,
    update: Pick<CallRecord, 'endedAt' | 'outcome' | 'bookingId'>,
  ): Promise<void> {
    const result = await this.pool.query(
      'UPDATE calls SET ended_at = $3, outcome = $4, booking_id = $5 WHERE tenant_id = $1 AND call_id = $2',
      [tenantId, callId, update.endedAt, update.outcome, update.bookingId],
    );
    if (result.rowCount === 0) throw new Error(`call not found: ${callId}`);
  }

  async getById(tenantId: string, callId: string): Promise<CallRecord | null> {
    const { rows } = await this.pool.query<CallRow>(
      'SELECT * FROM calls WHERE tenant_id = $1 AND call_id = $2',
      [tenantId, callId],
    );
    return rows[0] ? toCallRecord(rows[0]) : null;
  }

  async listByTenant(tenantId: string, limit = 100): Promise<CallRecord[]> {
    const { rows } = await this.pool.query<CallRow>(
      'SELECT * FROM calls WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2',
      [tenantId, limit],
    );
    return rows.map(toCallRecord);
  }
}

export class PostgresTranscriptRepository implements ITranscriptRepository {
  constructor(private readonly pool: Pool) {}

  async append(turn: TranscriptTurn): Promise<void> {
    await this.pool.query(
      `INSERT INTO transcript_turns (tenant_id, call_id, turn_index, role, text, ts)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [turn.tenantId, turn.callId, turn.turnIndex, turn.role, turn.text, turn.timestamp],
    );
  }

  async listByCall(tenantId: string, callId: string): Promise<TranscriptTurn[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM transcript_turns WHERE tenant_id = $1 AND call_id = $2 ORDER BY turn_index',
      [tenantId, callId],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      callId: r.call_id,
      turnIndex: r.turn_index,
      role: r.role,
      text: r.text,
      timestamp: r.ts,
    }));
  }
}

export class PostgresLeadRepository implements ILeadRepository {
  constructor(private readonly pool: Pool) {}

  async create(lead: LeadRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO leads (lead_id, tenant_id, call_id, caller_name, phone_number, service_need, preferred_time, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        lead.leadId,
        lead.tenantId,
        lead.callId,
        lead.callerName,
        lead.phoneNumber,
        lead.serviceNeed,
        lead.preferredTime,
        lead.createdAt,
      ],
    );
  }

  async listByTenant(tenantId: string, limit = 100): Promise<LeadRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
      [tenantId, limit],
    );
    return rows.map((r) => ({
      leadId: r.lead_id,
      tenantId: r.tenant_id,
      callId: r.call_id,
      callerName: r.caller_name,
      phoneNumber: r.phone_number,
      serviceNeed: r.service_need,
      preferredTime: r.preferred_time,
      createdAt: r.created_at,
    }));
  }
}

export class PostgresCallSummaryRepository implements ICallSummaryRepository {
  constructor(private readonly pool: Pool) {}

  async create(summary: CallSummaryRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO call_summaries (tenant_id, call_id, summary, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, call_id) DO UPDATE SET summary = EXCLUDED.summary`,
      [summary.tenantId, summary.callId, summary.summary, summary.createdAt],
    );
  }

  async getByCall(tenantId: string, callId: string): Promise<CallSummaryRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM call_summaries WHERE tenant_id = $1 AND call_id = $2',
      [tenantId, callId],
    );
    const r = rows[0];
    return r ? { tenantId: r.tenant_id, callId: r.call_id, summary: r.summary, createdAt: r.created_at } : null;
  }
}
