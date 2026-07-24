import type { ConversationState } from '../conversation/state.js';

/**
 * Persistence abstractions. All repositories are tenant-scoped: every row
 * carries a `tenantId` and every query filters by it, so one tenant can
 * never read another tenant's data. Implementations live in
 * `@platform/data` (Postgres for durable records, Redis for in-progress
 * session state, plus in-memory variants for tests and simulation mode).
 */

export type CallOutcome = 'booked' | 'escalated' | 'abandoned' | 'completed' | 'in_progress';

export interface CallRecord {
  callId: string;
  tenantId: string;
  fromNumber: string;
  toNumber: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: CallOutcome;
  /** Booking confirmation id, when outcome is 'booked'. */
  bookingId: string | null;
}

export interface TranscriptTurn {
  callId: string;
  tenantId: string;
  /** 0-based position of this turn within the call. */
  turnIndex: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
}

export interface LeadRecord {
  leadId: string;
  tenantId: string;
  callId: string;
  callerName: string | null;
  phoneNumber: string | null;
  serviceNeed: string | null;
  preferredTime: string | null;
  createdAt: Date;
}

export interface CallSummaryRecord {
  callId: string;
  tenantId: string;
  summary: string;
  createdAt: Date;
}

export interface ICallRepository {
  create(record: CallRecord): Promise<void>;
  /** Update the mutable fields (endedAt, outcome, bookingId) of an existing call. */
  finalize(tenantId: string, callId: string, update: Pick<CallRecord, 'endedAt' | 'outcome' | 'bookingId'>): Promise<void>;
  getById(tenantId: string, callId: string): Promise<CallRecord | null>;
  listByTenant(tenantId: string, limit?: number): Promise<CallRecord[]>;
}

export interface ITranscriptRepository {
  append(turn: TranscriptTurn): Promise<void>;
  listByCall(tenantId: string, callId: string): Promise<TranscriptTurn[]>;
}

export interface ILeadRepository {
  create(lead: LeadRecord): Promise<void>;
  listByTenant(tenantId: string, limit?: number): Promise<LeadRecord[]>;
}

export interface ICallSummaryRepository {
  create(summary: CallSummaryRecord): Promise<void>;
  getByCall(tenantId: string, callId: string): Promise<CallSummaryRecord | null>;
}

/**
 * Fast store for in-progress `ConversationState`, keyed by call id.
 * Entries expire after `ttlSeconds` so abandoned calls don't leak memory.
 */
export interface ISessionStore {
  get(callId: string): Promise<ConversationState | null>;
  set(callId: string, state: ConversationState, ttlSeconds?: number): Promise<void>;
  delete(callId: string): Promise<void>;
}
