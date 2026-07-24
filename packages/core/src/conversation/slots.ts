/**
 * The pieces of information the agent must collect before it can book an
 * appointment or capture a lead. Order matters: `SLOT_ORDER` defines the
 * default collection sequence used by the state machine.
 */
export type SlotName = 'callerName' | 'phoneNumber' | 'serviceNeed' | 'preferredTime';

export interface SlotValue {
  /** Raw value as extracted by the LLM tool call, or null if not yet collected. */
  value: string | null;
  /** True once the value has been read back to the caller and accepted. */
  confirmed: boolean;
  /** Number of times the agent has asked for this slot (used for fallback/escalation). */
  attempts: number;
}

export type SlotState = Record<SlotName, SlotValue>;

/** Default order in which slots are collected during `slot_filling`. */
export const SLOT_ORDER: readonly SlotName[] = ['callerName', 'phoneNumber', 'serviceNeed', 'preferredTime'];

export function createEmptySlotState(): SlotState {
  const state = {} as SlotState;
  for (const name of SLOT_ORDER) {
    state[name] = { value: null, confirmed: false, attempts: 0 };
  }
  return state;
}

export function setSlotValue(state: SlotState, name: SlotName, value: string): SlotState {
  return {
    ...state,
    [name]: { ...state[name], value, attempts: state[name].attempts + 1 },
  };
}

export function confirmSlot(state: SlotState, name: SlotName): SlotState {
  return {
    ...state,
    [name]: { ...state[name], confirmed: true },
  };
}

export function incrementSlotAttempts(state: SlotState, name: SlotName): SlotState {
  return {
    ...state,
    [name]: { ...state[name], attempts: state[name].attempts + 1 },
  };
}
