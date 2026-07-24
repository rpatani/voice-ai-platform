import type { ChatMessage } from '../interfaces/llm.js';
import { type SlotState, createEmptySlotState } from './slots.js';

/**
 * The high-level stage of the conversation. Drives which prompts/tools are
 * active and what the fallback handler should do.
 */
export type ConversationStep =
  | 'greeting'
  | 'slot_filling'
  | 'confirmation'
  | 'booking'
  | 'closing'
  | 'escalated'
  | 'completed';

/**
 * Full state for one in-progress (or completed) call. This is the object
 * persisted to Redis between turns and ultimately written to Postgres at
 * call end. It is plain, serializable data - the state machine in
 * `state-machine.ts` operates on it as pure functions.
 */
export interface ConversationState {
  callId: string;
  tenantId: string;
  step: ConversationStep;
  slots: SlotState;
  /** Full message history sent to the LLM (system + user + assistant + tool). */
  history: ChatMessage[];
  /** Consecutive fallback/clarification triggers since the last successful slot update. */
  fallbackCount: number;
  /** Set once `createBooking` succeeds. */
  bookingConfirmationId?: string;
  /** ISO timestamp the call started. */
  startedAt: string;
}

export function createInitialConversationState(callId: string, tenantId: string): ConversationState {
  return {
    callId,
    tenantId,
    step: 'greeting',
    slots: createEmptySlotState(),
    history: [],
    fallbackCount: 0,
    startedAt: new Date().toISOString(),
  };
}
