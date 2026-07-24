import { describe, expect, it, vi } from 'vitest';
import { createInitialConversationState, type TenantConfig } from '@platform/core';
import { MockCalendarProvider, MockLlmProvider, type ScriptedLlmTurn } from '@platform/adapters-mock';
import { ConversationEngine, CLARIFICATION_PROMPT, ESCALATION_MESSAGE } from '../engine.js';
import { SentenceSplitter } from '../sentence-splitter.js';
import { renderSystemPrompt, OPERATIONAL_GUIDANCE } from '../prompt.js';
import { buildToolDefinitions } from '../tools.js';

const tenant: TenantConfig = {
  tenantId: 'demo-dental',
  displayName: 'Bright Smile Dental',
  inboundPhoneNumbers: ['+15551234567'],
  providers: { telephony: 'mock', stt: 'mock', llm: 'mock', tts: 'mock', calendar: 'mock' },
  providerOptions: {},
  businessHours: [{ day: 'mon', open: '09:00', close: '17:00' }],
  services: [{ id: 'cleaning', name: 'Routine cleaning', description: 'Standard cleaning', durationMinutes: 30 }],
  systemPromptTemplate: 'You work for {{businessName}}. Services: {{services}}. Hours: {{businessHours}}.',
  escalation: { transferNumber: '+15559876543', maxRetriesPerSlot: 3 },
};

function makeEngine(script: ScriptedLlmTurn[]) {
  const llm = new MockLlmProvider(script);
  const calendar = new MockCalendarProvider();
  const engine = new ConversationEngine({ llm, calendar, tenant });
  return { engine, llm, calendar };
}

const initialState = () => createInitialConversationState('call-1', 'demo-dental');

describe('SentenceSplitter', () => {
  it('emits complete sentences across deltas and flushes the tail', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('Hello the')).toEqual([]);
    expect(splitter.push('re! How can I help? I can')).toEqual(['Hello there!', 'How can I help?']);
    expect(splitter.flush()).toBe('I can');
    expect(splitter.flush()).toBeNull();
  });
});

describe('renderSystemPrompt', () => {
  it('substitutes placeholders and appends operational guidance', () => {
    const prompt = renderSystemPrompt(tenant);
    expect(prompt).toContain('Bright Smile Dental');
    expect(prompt).toContain('Routine cleaning (30 min)');
    expect(prompt).toContain('mon 09:00-17:00');
    expect(prompt).toContain(OPERATIONAL_GUIDANCE.trim());
  });
});

describe('buildToolDefinitions', () => {
  it('exposes the six conversation tools with tenant service ids', () => {
    const tools = buildToolDefinitions(tenant);
    expect(tools.map((t) => t.name)).toEqual([
      'update_slot',
      'check_availability',
      'book_appointment',
      'answer_faq',
      'escalate_to_human',
      'end_call',
    ]);
    const booking = tools.find((t) => t.name === 'book_appointment')!;
    expect(JSON.stringify(booking.parameters)).toContain('cleaning');
  });
});

describe('ConversationEngine', () => {
  it('startCall greets, streams sentences, and moves to slot_filling', async () => {
    const { engine } = makeEngine([{ text: 'Hi, thanks for calling Bright Smile Dental! How can I help you today?' }]);
    const sentences: string[] = [];
    const result = await engine.startCall(initialState(), (s) => void sentences.push(s));
    expect(result.reply).toContain('thanks for calling');
    expect(sentences).toEqual([
      'Hi, thanks for calling Bright Smile Dental!',
      'How can I help you today?',
    ]);
    expect(result.state.step).toBe('slot_filling');
    expect(result.state.history[0]!.role).toBe('system');
    expect(result.endCall).toBe(false);
  });

  it('applies update_slot tool calls, including confirmation', async () => {
    const { engine } = makeEngine([
      {
        toolCalls: [{ id: 'c1', name: 'update_slot', arguments: { name: 'callerName', value: 'Jane Doe' } }],
      },
      { text: 'Got it, Jane Doe. Is that right?' },
      {
        toolCalls: [{ id: 'c2', name: 'update_slot', arguments: { name: 'callerName', value: 'Jane Doe', confirmed: true } }],
      },
      { text: 'Great. What is your phone number?' },
    ]);
    let state = initialState();
    state.step = 'slot_filling';

    const first = await engine.handleUtterance(state, 'My name is Jane Doe');
    expect(first.state.slots.callerName.value).toBe('Jane Doe');
    expect(first.state.slots.callerName.confirmed).toBe(false);
    expect(first.reply).toContain('Is that right?');

    const second = await engine.handleUtterance(first.state, 'Yes');
    expect(second.state.slots.callerName.confirmed).toBe(true);
    // Tool result messages are appended for the LLM.
    const toolMessages = second.state.history.filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBe(2);
    expect(toolMessages.every((m) => JSON.parse(m.content).ok)).toBe(true);
  });

  it('rejects invalid slot names via a failed tool result, not a crash', async () => {
    const { engine } = makeEngine([
      { toolCalls: [{ id: 'c1', name: 'update_slot', arguments: { name: 'ssn', value: '123' } }] },
      { text: 'Sorry about that.' },
    ]);
    const result = await engine.handleUtterance(initialState(), 'whatever');
    const toolResult = JSON.parse(result.state.history.find((m) => m.role === 'tool')!.content);
    expect(toolResult.ok).toBe(false);
    expect(toolResult.error).toContain('invalid slot name');
  });

  it('checks availability through the calendar provider', async () => {
    const { engine } = makeEngine([
      {
        toolCalls: [{
          id: 'c1',
          name: 'check_availability',
          arguments: { serviceId: 'cleaning', preferredStartIso: '2026-07-10T15:00:00.000Z' },
        }],
      },
      { text: 'We have 3pm open on Friday. Shall I book it?' },
    ]);
    const result = await engine.handleUtterance(initialState(), 'Friday at 3pm works');
    const toolResult = JSON.parse(result.state.history.find((m) => m.role === 'tool')!.content);
    expect(toolResult.ok).toBe(true);
    expect(toolResult.slots[0].start).toBe('2026-07-10T15:00:00.000Z');
    expect(result.reply).toContain('Shall I book it?');
  });

  it('books through the calendar, records the id, and transitions to closing', async () => {
    const { engine, calendar } = makeEngine([
      {
        toolCalls: [{
          id: 'c1',
          name: 'book_appointment',
          arguments: { serviceId: 'cleaning', startIso: '2026-07-10T15:00:00.000Z' },
        }],
      },
      { text: 'You are booked for Friday at 3pm. Anything else?' },
    ]);
    let state = initialState();
    state.slots.callerName = { value: 'Jane Doe', confirmed: true, attempts: 1 };
    state.slots.phoneNumber = { value: '+15550001111', confirmed: true, attempts: 1 };
    const result = await engine.handleUtterance(state, 'Yes, book it');
    expect(result.state.bookingConfirmationId).toBe('mock-booking-1');
    expect(result.state.step).toBe('closing');
    expect(calendar.bookings[0]).toMatchObject({
      serviceId: 'cleaning',
      customerName: 'Jane Doe',
      customerPhone: '+15550001111',
      durationMinutes: 30,
    });
  });

  it('surfaces booking failures to the LLM without corrupting state', async () => {
    const { engine, calendar } = makeEngine([
      {
        toolCalls: [{
          id: 'c1',
          name: 'book_appointment',
          arguments: { serviceId: 'cleaning', startIso: '2026-07-10T15:00:00.000Z' },
        }],
      },
      { text: 'I hit a snag booking that. Can I take your details and have someone call back?' },
    ]);
    calendar.failNextBooking = true;
    const result = await engine.handleUtterance(initialState(), 'Book it');
    const toolResult = JSON.parse(result.state.history.find((m) => m.role === 'tool')!.content);
    expect(toolResult.ok).toBe(false);
    expect(result.state.bookingConfirmationId).toBeUndefined();
    expect(result.state.step).not.toBe('closing');
  });

  it('escalates when the model calls escalate_to_human', async () => {
    const { engine } = makeEngine([
      {
        text: 'Of course, let me get someone for you.',
        toolCalls: [{ id: 'c1', name: 'escalate_to_human', arguments: { reason: 'caller asked for human' } }],
      },
    ]);
    const result = await engine.handleUtterance(initialState(), 'I want to talk to a person');
    expect(result.escalated).toBe(true);
    expect(result.transferNumber).toBe('+15559876543');
    expect(result.state.step).toBe('escalated');
  });

  it('speaks the escalation message when the model escalates silently', async () => {
    const { engine } = makeEngine([
      { toolCalls: [{ id: 'c1', name: 'escalate_to_human', arguments: { reason: 'stuck' } }] },
    ]);
    const sentences: string[] = [];
    const result = await engine.handleUtterance(initialState(), 'gibberish', (s) => void sentences.push(s));
    expect(result.reply).toBe(ESCALATION_MESSAGE);
    expect(sentences).toContain(ESCALATION_MESSAGE);
  });

  it('ends the call when the model calls end_call', async () => {
    const { engine } = makeEngine([
      { text: 'Goodbye!', toolCalls: [{ id: 'c1', name: 'end_call', arguments: {} }] },
    ]);
    const result = await engine.handleUtterance(initialState(), 'No, that is all, thanks');
    expect(result.endCall).toBe(true);
    expect(result.state.step).toBe('completed');
  });

  it('caps runaway tool loops at 5 LLM rounds per turn', async () => {
    const loopTurn = { toolCalls: [{ id: 'c', name: 'answer_faq', arguments: { question: 'hours?' } }] };
    const { engine, llm } = makeEngine(Array(10).fill(loopTurn));
    await engine.handleUtterance(initialState(), 'What are your hours?');
    expect(llm.receivedMessages.length).toBe(5);
  });

  it('handles unknown tools gracefully', async () => {
    const { engine } = makeEngine([
      { toolCalls: [{ id: 'c1', name: 'launch_rocket', arguments: {} }] },
      { text: 'Sorry, where were we?' },
    ]);
    const result = await engine.handleUtterance(initialState(), 'hm');
    const toolResult = JSON.parse(result.state.history.find((m) => m.role === 'tool')!.content);
    expect(toolResult.error).toContain('unknown tool');
  });

  it('handleFallback asks for clarification, then escalates once the budget is spent', () => {
    const { engine } = makeEngine([]);
    let state = initialState();
    state.step = 'slot_filling';

    const first = engine.handleFallback(state);
    expect(first.reply).toBe(CLARIFICATION_PROMPT);
    expect(first.escalated).toBe(false);
    expect(first.state.fallbackCount).toBe(1);

    const second = engine.handleFallback(first.state);
    const third = engine.handleFallback(second.state);
    expect(third.escalated).toBe(true);
    expect(third.reply).toBe(ESCALATION_MESSAGE);
    expect(third.state.step).toBe('escalated');
    expect(third.transferNumber).toBe('+15559876543');
  });

  it('does not mutate the input state object', async () => {
    const { engine } = makeEngine([{ text: 'Hello!' }]);
    const state = initialState();
    const historyBefore = state.history.length;
    await engine.handleUtterance(state, 'hi');
    expect(state.history.length).toBe(historyBefore);
  });
});
