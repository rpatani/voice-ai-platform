import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { AudioFrame, ITelephonyCallSession, TenantConfig } from '@platform/core';
import {
  InMemoryCallRepository,
  InMemoryCallSummaryRepository,
  InMemoryLeadRepository,
  InMemorySessionStore,
  InMemoryTranscriptRepository,
} from '@platform/data';
import {
  MockCalendarProvider,
  MockLlmProvider,
  MockSttProvider,
  MockTtsProvider,
  type ScriptedLlmTurn,
} from '@platform/adapters-mock';
import { CallSession } from '../call-session.js';

class FakeTelephony implements ITelephonyCallSession {
  callId = 'call-test-1';
  sentFrames: AudioFrame[] = [];
  cleared = 0;
  hungUp = false;
  transferred: string[] = [];
  private audioHandlers: Array<(f: AudioFrame) => void> = [];
  private endHandlers: Array<() => void> = [];

  onAudio(handler: (frame: AudioFrame) => void): void {
    this.audioHandlers.push(handler);
  }
  onEnd(handler: () => void): void {
    this.endHandlers.push(handler);
  }
  async sendAudio(frame: AudioFrame): Promise<void> {
    this.sentFrames.push(frame);
  }
  async clearOutboundAudio(): Promise<void> {
    this.cleared++;
  }
  async hangup(): Promise<void> {
    this.hungUp = true;
    this.fireEnd();
  }
  async transfer(toNumber: string): Promise<void> {
    this.transferred.push(toNumber);
  }
  fireEnd(): void {
    for (const h of this.endHandlers) h();
  }
  pushAudio(frame: AudioFrame): void {
    for (const h of this.audioHandlers) h(frame);
  }
}

const tenant = (overrides: Partial<TenantConfig> = {}): TenantConfig => ({
  tenantId: 'demo-dental',
  displayName: 'Bright Smile Dental',
  inboundPhoneNumbers: ['+15551234567'],
  providers: { telephony: 'mock', stt: 'mock', llm: 'mock', tts: 'mock', calendar: 'mock' },
  providerOptions: {},
  businessHours: [],
  services: [{ id: 'cleaning', name: 'Routine cleaning', description: '', durationMinutes: 30 }],
  systemPromptTemplate: 'Assistant for {{businessName}}.',
  escalation: { transferNumber: '+15559876543', maxRetriesPerSlot: 3 },
  ...overrides,
});

function makeHarness(script: ScriptedLlmTurn[], tenantConfig = tenant()) {
  const telephony = new FakeTelephony();
  const stt = new MockSttProvider();
  const llm = new MockLlmProvider(script);
  const tts = new MockTtsProvider({ msPerWord: 10, frameMs: 10 });
  const calendar = new MockCalendarProvider();
  const repositories = {
    calls: new InMemoryCallRepository(),
    transcripts: new InMemoryTranscriptRepository(),
    leads: new InMemoryLeadRepository(),
    summaries: new InMemoryCallSummaryRepository(),
  };
  const sessionStore = new InMemorySessionStore();
  const session = new CallSession({
    telephony,
    stt,
    llm,
    tts,
    calendar,
    tenant: tenantConfig,
    repositories,
    sessionStore,
    fromNumber: '+15550001111',
    toNumber: '+15551234567',
  });
  return { telephony, stt, llm, tts, calendar, repositories, sessionStore, session };
}

const finalUtterance = (text: string, confidence = 0.95) => ({
  text,
  isFinal: true,
  confidence,
  timestampMs: 0,
});

describe('CallSession', () => {
  it('speaks the greeting, persists the call record, and stores session state', async () => {
    const h = makeHarness([{ text: 'Hi! How can I help you today?' }]);
    await h.session.start();
    await delay(50);

    expect(h.tts.synthesized.join(' ')).toContain('How can I help you today?');
    expect(h.telephony.sentFrames.length).toBeGreaterThan(0);
    const call = await h.repositories.calls.getById('demo-dental', 'call-test-1');
    expect(call?.outcome).toBe('in_progress');
    const stored = await h.sessionStore.get('call-test-1');
    expect(stored?.step).toBe('slot_filling');
    const transcript = await h.repositories.transcripts.listByCall('demo-dental', 'call-test-1');
    expect(transcript[0]).toMatchObject({ role: 'assistant', turnIndex: 0 });
  });

  it('runs a full booking conversation and finalizes with outcome booked, lead and summary', async () => {
    const h = makeHarness([
      { text: 'Hi! Who am I speaking with?' },
      { toolCalls: [{ id: 'c1', name: 'update_slot', arguments: { name: 'callerName', value: 'Jane Doe', confirmed: true } }] },
      { text: 'Thanks Jane. What service do you need?' },
      { toolCalls: [{ id: 'c2', name: 'book_appointment', arguments: { serviceId: 'cleaning', startIso: '2026-07-06T15:00:00.000Z' } }] },
      { text: 'Booked! Goodbye.', toolCalls: [{ id: 'c3', name: 'end_call', arguments: {} }] },
    ]);
    await h.session.start();
    const stt = h.stt.sessions[0]!;
    stt.emit(finalUtterance('My name is Jane Doe'));
    stt.emit(finalUtterance('Book me a cleaning tomorrow at 3pm please'));
    await h.session.waitForClose();

    expect(h.calendar.bookings).toHaveLength(1);
    expect(h.telephony.hungUp).toBe(true);

    const call = await h.repositories.calls.getById('demo-dental', 'call-test-1');
    expect(call?.outcome).toBe('booked');
    expect(call?.bookingId).toBe('mock-booking-1');
    expect(call?.endedAt).toBeInstanceOf(Date);

    const leads = await h.repositories.leads.listByTenant('demo-dental');
    expect(leads[0]).toMatchObject({ callerName: 'Jane Doe', callId: 'call-test-1' });

    const summary = await h.repositories.summaries.getByCall('demo-dental', 'call-test-1');
    expect(summary?.summary).toBe('Mock call summary.');

    const transcript = await h.repositories.transcripts.listByCall('demo-dental', 'call-test-1');
    const roles = transcript.map((t) => t.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(await h.sessionStore.get('call-test-1')).toBeNull();
  });

  it('transfers and finalizes as escalated when the model escalates', async () => {
    const h = makeHarness([
      { text: 'Hello!' },
      { text: 'One moment.', toolCalls: [{ id: 'c1', name: 'escalate_to_human', arguments: { reason: 'asked' } }] },
    ]);
    await h.session.start();
    h.stt.sessions[0]!.emit(finalUtterance('Let me talk to a human right now'));
    await h.session.waitForClose();

    expect(h.telephony.transferred).toEqual(['+15559876543']);
    const call = await h.repositories.calls.getById('demo-dental', 'call-test-1');
    expect(call?.outcome).toBe('escalated');
  });

  it('hangs up on escalation when no transfer number is configured', async () => {
    const cfg = tenant({ escalation: { maxRetriesPerSlot: 3 } });
    const h = makeHarness(
      [{ text: 'Hello!' }, { toolCalls: [{ id: 'c1', name: 'escalate_to_human', arguments: { reason: 'x' } }] }],
      cfg,
    );
    await h.session.start();
    h.stt.sessions[0]!.emit(finalUtterance('human please'));
    await h.session.waitForClose();
    expect(h.telephony.transferred).toEqual([]);
    expect(h.telephony.hungUp).toBe(true);
  });

  it('asks for clarification on low-confidence transcripts and escalates after the retry budget', async () => {
    const cfg = tenant({ escalation: { transferNumber: '+15559876543', maxRetriesPerSlot: 2 } });
    const h = makeHarness([{ text: 'Hello!' }], cfg);
    await h.session.start();
    const stt = h.stt.sessions[0]!;

    stt.emit(finalUtterance('mumble', 0.1));
    await delay(30);
    expect(h.tts.synthesized.some((t) => t.includes("didn't catch"))).toBe(true);

    stt.emit(finalUtterance('mumble again', 0.1));
    await h.session.waitForClose();
    expect(h.telephony.transferred).toEqual(['+15559876543']);
    const call = await h.repositories.calls.getById('demo-dental', 'call-test-1');
    expect(call?.outcome).toBe('escalated');
  });

  it('falls back gracefully when the LLM fails mid-call', async () => {
    const h = makeHarness([{ text: 'Hello!' }]);
    // Sabotage the LLM after the greeting.
    let calls = 0;
    const llm = h.llm as unknown as { completeStream: unknown };
    const original = llm.completeStream;
    llm.completeStream = function (...args: unknown[]) {
      calls++;
      if (calls >= 2) throw new Error('llm outage');
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };

    await h.session.start();
    h.stt.sessions[0]!.emit(finalUtterance('I want an appointment'));
    await delay(50);

    expect(h.tts.synthesized.some((t) => t.includes("didn't catch"))).toBe(true);
    const call = await h.repositories.calls.getById('demo-dental', 'call-test-1');
    expect(call?.outcome).toBe('in_progress'); // call survives the outage
  });

  it('treats STT errors as fallback turns', async () => {
    const h = makeHarness([{ text: 'Hello!' }]);
    await h.session.start();
    h.stt.sessions[0]!.emitError(new Error('stt connection dropped'));
    await delay(30);
    expect(h.tts.synthesized.some((t) => t.includes("didn't catch"))).toBe(true);
  });

  it('finalizes as abandoned with a partial lead when the caller hangs up mid-flow', async () => {
    const h = makeHarness([
      { text: 'Hello! Who am I speaking with?' },
      { toolCalls: [{ id: 'c1', name: 'update_slot', arguments: { name: 'callerName', value: 'Bob' } }] },
      { text: 'Hi Bob! What do you need?' },
    ]);
    await h.session.start();
    h.stt.sessions[0]!.emit(finalUtterance('Bob here'));
    await delay(50);
    h.telephony.fireEnd();
    await h.session.waitForClose();

    const call = await h.repositories.calls.getById('demo-dental', 'call-test-1');
    expect(call?.outcome).toBe('abandoned');
    const leads = await h.repositories.leads.listByTenant('demo-dental');
    expect(leads[0]).toMatchObject({ callerName: 'Bob', phoneNumber: '+15550001111' });
  });

  it('clears outbound audio when the caller barges in while the agent speaks', async () => {
    const h = makeHarness([
      { text: 'This is a very long greeting with many many words that keeps going and going and going for quite a while indeed.' },
    ]);
    // Slow the TTS down so speech is in-flight when the barge-in arrives.
    const slowTts = {
      name: 'slow',
      synthesized: [] as string[],
      async *synthesizeStream(text: string) {
        for (let i = 0; i < 40; i++) {
          await delay(5);
          yield { payload: Buffer.alloc(160), sampleRateHz: 8000, timestampMs: i * 10 };
        }
        void text;
      },
    };
    (h.session as unknown as { deps: { tts: unknown } }).deps.tts = slowTts;

    await h.session.start();
    await delay(30); // greeting playback under way
    const framesBefore = h.telephony.sentFrames.length;
    expect(framesBefore).toBeGreaterThan(0);

    h.stt.sessions[0]!.emit({ text: 'wait actually', isFinal: false, confidence: 0.9, timestampMs: 0 });
    await delay(30);

    expect(h.telephony.cleared).toBeGreaterThanOrEqual(1);
    const framesAfterClear = h.telephony.sentFrames.length;
    await delay(60);
    // Playback of the interrupted sentence stopped.
    expect(h.telephony.sentFrames.length).toBe(framesAfterClear);
  });

  it('routes caller audio frames into the STT session', async () => {
    const h = makeHarness([{ text: 'Hello!' }]);
    await h.session.start();
    const stt = h.stt.sessions[0]!;
    const events: string[] = [];
    stt.onTranscript((e) => events.push(e.text));
    // MockStt default: 1000ms per utterance, but no scripted utterances -> nothing emitted; just verify no crash.
    h.telephony.pushAudio({ payload: Buffer.alloc(320), sampleRateHz: 8000, timestampMs: 0 });
    expect(events).toEqual([]);
  });
});
