import { describe, expect, it } from 'vitest';
import { createInitialConversationState } from '../conversation/state.js';
import {
  allSlotsFilled,
  deriveNextStep,
  isTerminal,
  nextUnfilledSlot,
  recordFallback,
  resetFallbackCounter,
  transitionTo,
} from '../conversation/state-machine.js';
import { confirmSlot, setSlotValue, SLOT_ORDER } from '../conversation/slots.js';

const MAX_FALLBACKS = 3;

describe('slot progression', () => {
  it('reports the first slot as unfilled on a fresh conversation', () => {
    const state = createInitialConversationState('call-1', 'tenant-1');
    expect(nextUnfilledSlot(state)).toBe(SLOT_ORDER[0]);
    expect(allSlotsFilled(state)).toBe(false);
  });

  it('progresses through slots in order as they are confirmed', () => {
    let state = createInitialConversationState('call-1', 'tenant-1');

    for (const slot of SLOT_ORDER) {
      expect(nextUnfilledSlot(state)).toBe(slot);
      state = { ...state, slots: confirmSlot(setSlotValue(state.slots, slot, 'some value'), slot) };
    }

    expect(nextUnfilledSlot(state)).toBeNull();
    expect(allSlotsFilled(state)).toBe(true);
  });
});

describe('deriveNextStep', () => {
  it('moves from greeting to slot_filling', () => {
    const state = createInitialConversationState('call-1', 'tenant-1');
    expect(deriveNextStep(state, MAX_FALLBACKS)).toBe('slot_filling');
  });

  it('stays in slot_filling until all slots are confirmed', () => {
    let state = transitionTo(createInitialConversationState('call-1', 'tenant-1'), 'slot_filling');
    expect(deriveNextStep(state, MAX_FALLBACKS)).toBe('slot_filling');

    for (const slot of SLOT_ORDER) {
      state = { ...state, slots: confirmSlot(setSlotValue(state.slots, slot, 'x'), slot) };
    }

    expect(deriveNextStep(state, MAX_FALLBACKS)).toBe('confirmation');
  });

  it('moves from booking to closing only once a booking confirmation exists', () => {
    let state = transitionTo(createInitialConversationState('call-1', 'tenant-1'), 'booking');
    expect(deriveNextStep(state, MAX_FALLBACKS)).toBe('booking');

    state = { ...state, bookingConfirmationId: 'evt_123' };
    expect(deriveNextStep(state, MAX_FALLBACKS)).toBe('closing');
  });

  it('moves from closing to completed', () => {
    const state = transitionTo(createInitialConversationState('call-1', 'tenant-1'), 'closing');
    expect(deriveNextStep(state, MAX_FALLBACKS)).toBe('completed');
  });

  it('escalates once fallbackCount reaches the configured maximum', () => {
    let state = transitionTo(createInitialConversationState('call-1', 'tenant-1'), 'slot_filling');

    for (let i = 0; i < MAX_FALLBACKS; i++) {
      state = recordFallback(state);
    }

    expect(deriveNextStep(state, MAX_FALLBACKS)).toBe('escalated');
  });

  it('never transitions out of terminal states', () => {
    const completed = transitionTo(createInitialConversationState('call-1', 'tenant-1'), 'completed');
    expect(deriveNextStep(completed, MAX_FALLBACKS)).toBe('completed');
    expect(isTerminal(completed)).toBe(true);

    const escalated = transitionTo(createInitialConversationState('call-1', 'tenant-1'), 'escalated');
    expect(deriveNextStep(escalated, MAX_FALLBACKS)).toBe('escalated');
    expect(isTerminal(escalated)).toBe(true);
  });
});

describe('fallback counter', () => {
  it('increments on recordFallback and resets on transitionTo / resetFallbackCounter', () => {
    let state = createInitialConversationState('call-1', 'tenant-1');
    state = recordFallback(state);
    state = recordFallback(state);
    expect(state.fallbackCount).toBe(2);

    state = resetFallbackCounter(state);
    expect(state.fallbackCount).toBe(0);

    state = recordFallback(state);
    state = transitionTo(state, 'slot_filling');
    expect(state.fallbackCount).toBe(0);
  });
});
