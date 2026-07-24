import type { ConversationState, ConversationStep } from './state.js';
import { SLOT_ORDER, type SlotName } from './slots.js';

/**
 * Returns the next slot that still needs to be collected and confirmed,
 * in the order defined by `SLOT_ORDER`, or `null` if all slots are done.
 */
export function nextUnfilledSlot(state: ConversationState): SlotName | null {
  for (const name of SLOT_ORDER) {
    if (!state.slots[name].confirmed) return name;
  }
  return null;
}

export function allSlotsFilled(state: ConversationState): boolean {
  return nextUnfilledSlot(state) === null;
}

/**
 * Determines the conversation step that should follow the current one.
 *
 * This is a pure function with no I/O: given the same `state`, it always
 * returns the same result. The orchestration layer calls this after each
 * turn (and after fallback handling) to decide what happens next, and is
 * responsible for actually executing the corresponding action (prompting
 * the LLM, calling the booking adapter, ending the call, etc).
 *
 * `escalated` and `completed` are terminal - once reached, the state
 * machine will not transition out of them.
 */
export function deriveNextStep(state: ConversationState, maxFallbacks: number): ConversationStep {
  if (state.step === 'escalated' || state.step === 'completed') {
    return state.step;
  }

  if (state.fallbackCount >= maxFallbacks) {
    return 'escalated';
  }

  switch (state.step) {
    case 'greeting':
      return 'slot_filling';

    case 'slot_filling':
      return allSlotsFilled(state) ? 'confirmation' : 'slot_filling';

    case 'confirmation':
      // The orchestrator transitions to 'booking' only once the caller has
      // explicitly confirmed the recap; until then it stays here.
      return 'confirmation';

    case 'booking':
      return state.bookingConfirmationId ? 'closing' : 'booking';

    case 'closing':
      return 'completed';

    default:
      return state.step;
  }
}

/** Advance `state.step` to `nextStep`, resetting the fallback counter. */
export function transitionTo(state: ConversationState, nextStep: ConversationStep): ConversationState {
  return { ...state, step: nextStep, fallbackCount: 0 };
}

/**
 * Record that the fallback/clarification handler was triggered for this
 * turn (low STT confidence, off-topic question, unrecognized input, ...).
 */
export function recordFallback(state: ConversationState): ConversationState {
  return { ...state, fallbackCount: state.fallbackCount + 1 };
}

/** Reset the fallback counter after a successful turn. */
export function resetFallbackCounter(state: ConversationState): ConversationState {
  return state.fallbackCount === 0 ? state : { ...state, fallbackCount: 0 };
}

/** Whether the conversation has reached a terminal state and the call can be ended. */
export function isTerminal(state: ConversationState): boolean {
  return state.step === 'completed' || state.step === 'escalated';
}
