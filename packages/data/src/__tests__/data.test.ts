import { describe, expect, it, vi } from 'vitest';
import { createInitialConversationState, type CallRecord, type LeadRecord } from '@platform/core';
import {
  InMemoryCallRepository,
  InMemoryCallSummaryRepository,
  InMemoryLeadRepository,
  InMemorySessionStore,
  InMemoryTranscriptRepository,
} from '../in-memory.js';
import { RedisSessionStore, type RedisLike } from '../redis/session-store.js';
import { MIGRATIONS } from '../postgres/schema.js';

const call = (overrides: Partial<CallRecord> = {}): CallRecord => ({
  callId: 'call-1',
  tenantId: 'tenant-a',
  fromNumber: '+15550001111',
  toNumber: '+15551234567',
  startedAt: new Date('2026-07-05T10:00:00Z'),
  endedAt: null,
  outcome: 'in_progress',
  bookingId: null,
  ...overrides,
});

describe('InMemoryCallRepository', () => {
  it('creates, finalizes, and fetches a call', async () => {
    const repo = new InMemoryCallRepository();
    await repo.create(call());
    await repo.finalize('tenant-a', 'call-1', {
      endedAt: new Date('2026-07-05T10:03:00Z'),
      outcome: 'booked',
      bookingId: 'bk-9',
    });
    const fetched = await repo.getById('tenant-a', 'call-1');
    expect(fetched?.outcome).toBe('booked');
    expect(fetched?.bookingId).toBe('bk-9');
  });

  it('scopes reads by tenant', async () => {
    const repo = new InMemoryCallRepository();
    await repo.create(call({ tenantId: 'tenant-a' }));
    await repo.create(call({ callId: 'call-2', tenantId: 'tenant-b' }));
    expect(await repo.getById('tenant-b', 'call-1')).toBeNull();
    expect(await repo.listByTenant('tenant-a')).toHaveLength(1);
  });

  it('throws when finalizing an unknown call', async () => {
    const repo = new InMemoryCallRepository();
    await expect(
      repo.finalize('tenant-a', 'nope', { endedAt: new Date(), outcome: 'completed', bookingId: null }),
    ).rejects.toThrow('call not found');
  });

  it('lists newest calls first with a limit', async () => {
    const repo = new InMemoryCallRepository();
    for (let i = 0; i < 5; i++) {
      await repo.create(call({ callId: `call-${i}`, startedAt: new Date(2026, 6, 5, 10, i) }));
    }
    const list = await repo.listByTenant('tenant-a', 2);
    expect(list.map((c) => c.callId)).toEqual(['call-4', 'call-3']);
  });
});

describe('InMemoryTranscriptRepository', () => {
  it('appends and lists turns in order, tenant-scoped', async () => {
    const repo = new InMemoryTranscriptRepository();
    const base = { callId: 'call-1', tenantId: 'tenant-a', timestamp: new Date() } as const;
    await repo.append({ ...base, turnIndex: 1, role: 'assistant', text: 'Hi there' });
    await repo.append({ ...base, turnIndex: 0, role: 'user', text: 'Hello' });
    const turns = await repo.listByCall('tenant-a', 'call-1');
    expect(turns.map((t) => t.text)).toEqual(['Hello', 'Hi there']);
    expect(await repo.listByCall('tenant-b', 'call-1')).toEqual([]);
  });
});

describe('InMemoryLeadRepository', () => {
  it('stores and lists leads by tenant', async () => {
    const repo = new InMemoryLeadRepository();
    const lead: LeadRecord = {
      leadId: 'lead-1',
      tenantId: 'tenant-a',
      callId: 'call-1',
      callerName: 'Jane',
      phoneNumber: '+15550001111',
      serviceNeed: 'cleaning',
      preferredTime: 'tomorrow 3pm',
      createdAt: new Date(),
    };
    await repo.create(lead);
    expect(await repo.listByTenant('tenant-a')).toHaveLength(1);
    expect(await repo.listByTenant('tenant-b')).toHaveLength(0);
  });
});

describe('InMemoryCallSummaryRepository', () => {
  it('stores and retrieves a summary', async () => {
    const repo = new InMemoryCallSummaryRepository();
    await repo.create({ tenantId: 'tenant-a', callId: 'call-1', summary: 'Booked a cleaning.', createdAt: new Date() });
    expect((await repo.getByCall('tenant-a', 'call-1'))?.summary).toBe('Booked a cleaning.');
    expect(await repo.getByCall('tenant-a', 'other')).toBeNull();
  });
});

describe('InMemorySessionStore', () => {
  it('round-trips conversation state with isolation from later mutation', async () => {
    const store = new InMemorySessionStore();
    const state = createInitialConversationState('call-1', 'tenant-a');
    await store.set('call-1', state);
    state.step = 'booking';
    const loaded = await store.get('call-1');
    expect(loaded?.step).toBe('greeting');
  });

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemorySessionStore(1);
      await store.set('call-1', createInitialConversationState('call-1', 'tenant-a'));
      vi.advanceTimersByTime(1500);
      expect(await store.get('call-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes entries', async () => {
    const store = new InMemorySessionStore();
    await store.set('call-1', createInitialConversationState('call-1', 'tenant-a'));
    await store.delete('call-1');
    expect(await store.get('call-1')).toBeNull();
  });
});

describe('RedisSessionStore', () => {
  it('serializes state as JSON with prefix and TTL', async () => {
    const backing = new Map<string, string>();
    const fake: RedisLike = {
      get: vi.fn(async (k) => backing.get(k) ?? null),
      set: vi.fn(async (k, v) => backing.set(k, v)),
      del: vi.fn(async (k) => backing.delete(k)),
    };
    const store = new RedisSessionStore(fake, 1800);
    const state = createInitialConversationState('call-1', 'tenant-a');
    await store.set('call-1', state);
    expect(fake.set).toHaveBeenCalledWith('session:call-1', expect.any(String), { EX: 1800 });
    const loaded = await store.get('call-1');
    expect(loaded?.callId).toBe('call-1');
    expect(loaded?.slots.callerName.confirmed).toBe(false);
    await store.delete('call-1');
    expect(await store.get('call-1')).toBeNull();
  });
});

describe('postgres migrations', () => {
  it('has strictly increasing versions and tenant-scoped primary keys', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    const initSql = MIGRATIONS[0]!.sql;
    for (const table of ['calls', 'transcript_turns', 'leads', 'call_summaries']) {
      expect(initSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(initSql).toMatch(new RegExp(`${table}[\\s\\S]*?tenant_id\\s+TEXT NOT NULL`));
    }
  });
});
