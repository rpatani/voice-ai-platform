import type {
  ChatMessage,
  ConversationState,
  ICalendarProvider,
  ILLMProvider,
  TenantConfig,
  ToolCall,
} from '@platform/core';
import {
  SLOT_ORDER,
  type SlotName,
  confirmSlot,
  setSlotValue,
  deriveNextStep,
  isTerminal,
  recordFallback,
  transitionTo,
} from '@platform/core';
import {
  bookingsCreatedTotal,
  escalationsTotal,
  fallbackTotal,
  getLogger,
  providerErrorTotal,
  turnLatencyMs,
  withSpan,
} from '@platform/observability';
import { renderSystemPrompt } from './prompt.js';
import { buildToolDefinitions } from './tools.js';
import { SentenceSplitter } from './sentence-splitter.js';

const logger = getLogger({ component: 'engine' });

/** Cap on LLM<->tool round-trips within a single caller turn. */
const MAX_TOOL_ROUNDS = 5;

export interface EngineDeps {
  llm: ILLMProvider;
  calendar: ICalendarProvider;
  tenant: TenantConfig;
}

export interface TurnResult {
  state: ConversationState;
  /** Full assistant reply for this turn (already streamed via onSentence). */
  reply: string;
  /** True when the call should now be ended gracefully. */
  endCall: boolean;
  /** True when the call should be handed to a human. */
  escalated: boolean;
  /** Number to transfer to when escalated, if the tenant configured one. */
  transferNumber?: string;
}

export type SentenceHandler = (sentence: string) => void | Promise<void>;

export const CLARIFICATION_PROMPT = "Sorry, I didn't catch that. Could you say it again?";
export const ESCALATION_MESSAGE = 'Let me connect you with a member of our team who can help. One moment please.';

/**
 * The provider-agnostic conversation engine: drives the LLM turn loop,
 * executes tool calls against domain state and the calendar provider, and
 * applies the pure state machine from `@platform/core` after each turn.
 * Emits complete sentences via `onSentence` as they stream, so TTS can
 * begin before the model finishes.
 */
export class ConversationEngine {
  constructor(private readonly deps: EngineDeps) {}

  /** Start the call: install the system prompt and produce the greeting. */
  async startCall(state: ConversationState, onSentence?: SentenceHandler): Promise<TurnResult> {
    let working = structuredClone(state);
    working.history = [
      { role: 'system', content: renderSystemPrompt(this.deps.tenant) },
      { role: 'user', content: '[The caller has just connected. Greet them.]' },
    ];
    return this.runTurn(working, onSentence);
  }

  /** Handle one final transcript from the caller. */
  async handleUtterance(state: ConversationState, text: string, onSentence?: SentenceHandler): Promise<TurnResult> {
    const working = structuredClone(state);
    working.history.push({ role: 'user', content: text });
    return this.runTurn(working, onSentence);
  }

  /**
   * Handle an unusable caller turn (low STT confidence, silence, STT error)
   * without an LLM round-trip. Escalates once the tenant's retry budget is
   * exhausted.
   */
  handleFallback(state: ConversationState): TurnResult {
    fallbackTotal.add(1, { tenant: this.deps.tenant.tenantId });
    let working = recordFallback(structuredClone(state));
    const maxFallbacks = this.deps.tenant.escalation.maxRetriesPerSlot;
    if (deriveNextStep(working, maxFallbacks) === 'escalated') {
      working = transitionTo(working, 'escalated');
      escalationsTotal.add(1, { tenant: this.deps.tenant.tenantId, reason: 'fallback_budget' });
      working.history.push({ role: 'assistant', content: ESCALATION_MESSAGE });
      return {
        state: working,
        reply: ESCALATION_MESSAGE,
        endCall: false,
        escalated: true,
        transferNumber: this.deps.tenant.escalation.transferNumber,
      };
    }
    working.history.push({ role: 'assistant', content: CLARIFICATION_PROMPT });
    return { state: working, reply: CLARIFICATION_PROMPT, endCall: false, escalated: false };
  }

  private async runTurn(state: ConversationState, onSentence?: SentenceHandler): Promise<TurnResult> {
    return withSpan('engine.turn', async (span) => {
      span.setAttribute('tenant.id', state.tenantId);
      span.setAttribute('call.id', state.callId);
      const startedAt = Date.now();
      const tools = buildToolDefinitions(this.deps.tenant);
      const replyParts: string[] = [];
      let endCall = false;
      let escalated = false;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const splitter = new SentenceSplitter();
        let turnText = '';
        let toolCalls: ToolCall[] | undefined;

        const llmStart = Date.now();
        for await (const chunk of this.deps.llm.completeStream(state.history, tools)) {
          if (chunk.deltaText) {
            turnText += chunk.deltaText;
            for (const sentence of splitter.push(chunk.deltaText)) {
              await onSentence?.(sentence);
            }
          }
          if (chunk.finished) toolCalls = chunk.toolCalls;
        }
        turnLatencyMs.record(Date.now() - llmStart, { stage: 'llm' });

        const trailing = splitter.flush();
        if (trailing) await onSentence?.(trailing);
        if (turnText) replyParts.push(turnText);

        const assistantMessage: ChatMessage = { role: 'assistant', content: turnText };
        if (toolCalls?.length) assistantMessage.toolCalls = toolCalls;
        state.history.push(assistantMessage);

        if (!toolCalls?.length) break;

        for (const call of toolCalls) {
          const execution = await this.executeTool(state, call);
          state = execution.state;
          endCall ||= execution.endCall;
          escalated ||= execution.escalated;
          state.history.push({ role: 'tool', content: execution.result, toolCallId: call.id });
        }
        if (escalated || endCall) {
          // Terminal tools end the turn; any text already streamed is the goodbye.
          break;
        }
      }

      if (escalated && replyParts.length === 0) {
        // The model escalated without saying anything - never leave the
        // caller in silence.
        replyParts.push(ESCALATION_MESSAGE);
        state.history.push({ role: 'assistant', content: ESCALATION_MESSAGE });
        await onSentence?.(ESCALATION_MESSAGE);
      }

      state = this.applyTransitions(state, { endCall, escalated });
      turnLatencyMs.record(Date.now() - startedAt, { stage: 'turn_total' });

      return {
        state,
        reply: replyParts.join(' ').trim(),
        endCall: endCall || state.step === 'completed',
        escalated,
        transferNumber: escalated ? this.deps.tenant.escalation.transferNumber : undefined,
      };
    });
  }

  private async executeTool(
    state: ConversationState,
    call: ToolCall,
  ): Promise<{ state: ConversationState; result: string; endCall: boolean; escalated: boolean }> {
    return withSpan(
      'engine.tool',
      async () => {
        try {
          switch (call.name) {
            case 'update_slot':
              return { state: this.applyUpdateSlot(state, call.arguments), result: ok(), endCall: false, escalated: false };
            case 'check_availability':
              return { state, result: await this.applyCheckAvailability(call.arguments), endCall: false, escalated: false };
            case 'book_appointment': {
              const { newState, result } = await this.applyBooking(state, call.arguments);
              return { state: newState, result, endCall: false, escalated: false };
            }
            case 'answer_faq':
              return { state, result: this.applyFaq(), endCall: false, escalated: false };
            case 'escalate_to_human':
              escalationsTotal.add(1, { tenant: this.deps.tenant.tenantId, reason: 'llm_tool' });
              logger.info({ callId: state.callId, reason: call.arguments['reason'] }, 'engine: escalating to human');
              return { state, result: ok(), endCall: false, escalated: true };
            case 'end_call':
              return { state, result: ok(), endCall: true, escalated: false };
            default:
              return { state, result: fail(`unknown tool: ${call.name}`), endCall: false, escalated: false };
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, tool: call.name, callId: state.callId }, 'engine: tool execution failed');
          return { state, result: fail(message), endCall: false, escalated: false };
        }
      },
      { 'tool.name': call.name },
    );
  }

  private applyUpdateSlot(state: ConversationState, args: Record<string, unknown>): ConversationState {
    const name = args['name'] as SlotName;
    const value = String(args['value'] ?? '');
    if (!SLOT_ORDER.includes(name)) throw new Error(`invalid slot name: ${String(args['name'])}`);
    if (!value) throw new Error('slot value must not be empty');
    let slots = setSlotValue(state.slots, name, value);
    if (args['confirmed'] === true) slots = confirmSlot(slots, name);
    return { ...state, slots, fallbackCount: 0 };
  }

  private async applyCheckAvailability(args: Record<string, unknown>): Promise<string> {
    const service = this.requireService(String(args['serviceId'] ?? ''));
    const preferredStart = parseIsoDate(String(args['preferredStartIso'] ?? ''));
    const slots = await withSpan('calendar.findAvailability', () =>
      this.deps.calendar.findAvailability({
        serviceId: service.id,
        preferredStart,
        durationMinutes: service.durationMinutes,
      }),
    );
    return JSON.stringify({ ok: true, slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })) });
  }

  private async applyBooking(
    state: ConversationState,
    args: Record<string, unknown>,
  ): Promise<{ newState: ConversationState; result: string }> {
    const service = this.requireService(String(args['serviceId'] ?? ''));
    const start = parseIsoDate(String(args['startIso'] ?? ''));
    try {
      const confirmation = await withSpan('calendar.createBooking', () =>
        this.deps.calendar.createBooking({
          serviceId: service.id,
          start,
          durationMinutes: service.durationMinutes,
          customerName: state.slots.callerName.value ?? 'Unknown caller',
          customerPhone: state.slots.phoneNumber.value ?? '',
          notes: `Booked by voice agent. Preferred time as stated: ${state.slots.preferredTime.value ?? 'n/a'}`,
        }),
      );
      bookingsCreatedTotal.add(1, { tenant: this.deps.tenant.tenantId });
      return {
        newState: { ...state, bookingConfirmationId: confirmation.bookingId },
        result: JSON.stringify({ ok: true, bookingId: confirmation.bookingId, start: confirmation.start.toISOString() }),
      };
    } catch (err) {
      providerErrorTotal.add(1, { provider: this.deps.calendar.name, operation: 'createBooking' });
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, callId: state.callId }, 'engine: booking failed');
      return { newState: state, result: fail(`booking failed: ${message}`) };
    }
  }

  private applyFaq(): string {
    const { displayName, businessHours, services } = this.deps.tenant;
    return JSON.stringify({ ok: true, businessName: displayName, businessHours, services });
  }

  private requireService(serviceId: string) {
    const service = this.deps.tenant.services.find((s) => s.id === serviceId);
    if (!service) throw new Error(`unknown serviceId: ${serviceId}`);
    return service;
  }

  private applyTransitions(
    state: ConversationState,
    outcome: { endCall: boolean; escalated: boolean },
  ): ConversationState {
    if (isTerminal(state)) return state;
    if (outcome.escalated) return transitionTo(state, 'escalated');
    if (outcome.endCall) return transitionTo(state, 'completed');
    if (state.bookingConfirmationId && state.step !== 'closing') {
      return transitionTo(state, 'closing');
    }
    const next = deriveNextStep(state, this.deps.tenant.escalation.maxRetriesPerSlot);
    return next === state.step ? state : transitionTo(state, next);
  }
}

const ok = () => JSON.stringify({ ok: true });
const fail = (error: string) => JSON.stringify({ ok: false, error });

function parseIsoDate(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ISO date: ${iso}`);
  return date;
}
