import type {
  CallRecord,
  CallSummaryRecord,
  ConversationState,
  ICallRepository,
  ICallSummaryRepository,
  ILeadRepository,
  ISessionStore,
  ITranscriptRepository,
  LeadRecord,
  TranscriptTurn,
} from '@platform/core';

/**
 * In-memory implementations of the persistence interfaces. Used by unit
 * tests and by simulation mode (`PERSISTENCE=memory`), where the platform
 * runs end-to-end with no external services. Semantics intentionally match
 * the Postgres implementations, including tenant scoping.
 */

const key = (tenantId: string, callId: string) => `${tenantId}:${callId}`;

export class InMemoryCallRepository implements ICallRepository {
  private readonly calls = new Map<string, CallRecord>();

  async create(record: CallRecord): Promise<void> {
    this.calls.set(key(record.tenantId, record.callId), { ...record });
  }

  async finalize(
    tenantId: string,
    callId: string,
    update: Pick<CallRecord, 'endedAt' | 'outcome' | 'bookingId'>,
  ): Promise<void> {
    const existing = this.calls.get(key(tenantId, callId));
    if (!existing) throw new Error(`call not found: ${callId}`);
    this.calls.set(key(tenantId, callId), { ...existing, ...update });
  }

  async getById(tenantId: string, callId: string): Promise<CallRecord | null> {
    const record = this.calls.get(key(tenantId, callId));
    return record ? { ...record } : null;
  }

  async listByTenant(tenantId: string, limit = 100): Promise<CallRecord[]> {
    return [...this.calls.values()]
      .filter((c) => c.tenantId === tenantId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }
}

export class InMemoryTranscriptRepository implements ITranscriptRepository {
  private readonly turns = new Map<string, TranscriptTurn[]>();

  async append(turn: TranscriptTurn): Promise<void> {
    const k = key(turn.tenantId, turn.callId);
    const list = this.turns.get(k) ?? [];
    list.push({ ...turn });
    this.turns.set(k, list);
  }

  async listByCall(tenantId: string, callId: string): Promise<TranscriptTurn[]> {
    const list = this.turns.get(key(tenantId, callId)) ?? [];
    return [...list].sort((a, b) => a.turnIndex - b.turnIndex);
  }
}

export class InMemoryLeadRepository implements ILeadRepository {
  private readonly leads: LeadRecord[] = [];

  async create(lead: LeadRecord): Promise<void> {
    this.leads.push({ ...lead });
  }

  async listByTenant(tenantId: string, limit = 100): Promise<LeadRecord[]> {
    return this.leads
      .filter((l) => l.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((l) => ({ ...l }));
  }
}

export class InMemoryCallSummaryRepository implements ICallSummaryRepository {
  private readonly summaries = new Map<string, CallSummaryRecord>();

  async create(summary: CallSummaryRecord): Promise<void> {
    this.summaries.set(key(summary.tenantId, summary.callId), { ...summary });
  }

  async getByCall(tenantId: string, callId: string): Promise<CallSummaryRecord | null> {
    const record = this.summaries.get(key(tenantId, callId));
    return record ? { ...record } : null;
  }
}

interface SessionEntry {
  state: ConversationState;
  expiresAt: number;
}

export class InMemorySessionStore implements ISessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly defaultTtlSeconds = 3600) {}

  async get(callId: string): Promise<ConversationState | null> {
    const entry = this.sessions.get(callId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(callId);
      return null;
    }
    // Deep copy so callers can't mutate stored state without calling set().
    return structuredClone(entry.state);
  }

  async set(callId: string, state: ConversationState, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    this.sessions.set(callId, { state: structuredClone(state), expiresAt: Date.now() + ttl * 1000 });
  }

  async delete(callId: string): Promise<void> {
    this.sessions.delete(callId);
  }
}
