/**
 * M12: end-to-end simulated call.
 *
 * Drives the REAL Twilio Media Streams adapter with protocol-level JSON
 * messages (start/media/stop) over a fake socket, through the real
 * CallSession orchestrator, conversation engine, and in-memory data layer,
 * using the scripted mock STT/LLM/TTS/calendar providers - i.e. everything
 * except live vendor APIs.
 */
import { setImmediate as tick } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { TenantConfig } from '@platform/core';
import { TwilioMediaStreamSession, type MediaSocket } from '@platform/adapters-twilio';
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
} from '@platform/adapters-mock';
import { CallSession } from '../call-session.js';
import { DEFAULT_SIM_SCRIPT } from '../registry.js';

const tenant: TenantConfig = {
  tenantId: 'demo-dental',
  displayName: 'Bright Smile Dental',
  inboundPhoneNumbers: ['+15551234567'],
  providers: { telephony: 'twilio', stt: 'mock', llm: 'mock', tts: 'mock', calendar: 'mock' },
  providerOptions: {},
  businessHours: [{ day: 'mon', open: '09:00', close: '17:00' }],
  services: [{ id: 'cleaning', name: 'Routine cleaning', description: '', durationMinutes: 30 }],
  systemPromptTemplate: 'You are the assistant for {{businessName}}. Services: {{services}}.',
  escalation: { transferNumber: '+15559876543', maxRetriesPerSlot: 3 },
};

/** 20ms of silence as a Twilio media message (160 mulaw bytes @8kHz). */
const mediaMessage = () =>
  JSON.stringify({ event: 'media', media: { payload: Buffer.alloc(160, 0xff).toString('base64') } });

describe('end-to-end simulated call', () => {
  it('books an appointment through the full pipeline and persists everything', async () => {
    const sent: string[] = [];
    let socketClosed = false;
    const socket: MediaSocket = {
      send: (data) => sent.push(data),
      close: () => {
        socketClosed = true;
      },
    };
    const media = new TwilioMediaStreamSession(socket);

    const stt = new MockSttProvider({
      utterances: [
        'My name is Jane Doe',
        'My number is 555 000 1111',
        'I need a cleaning',
        'Tomorrow at 3pm',
        'Yes book it',
        'No that is everything, thanks',
      ],
      msPerUtterance: 400,
    });
    const llm = new MockLlmProvider(DEFAULT_SIM_SCRIPT, 'Jane Doe booked a cleaning for tomorrow 3pm.');
    const tts = new MockTtsProvider({ msPerWord: 5, frameMs: 20 });
    const calendar = new MockCalendarProvider();
    const repositories = {
      calls: new InMemoryCallRepository(),
      transcripts: new InMemoryTranscriptRepository(),
      leads: new InMemoryLeadRepository(),
      summaries: new InMemoryCallSummaryRepository(),
    };
    const sessionStore = new InMemorySessionStore();

    // Wire up exactly as the server does on the Media Streams 'start' event.
    let callSession: CallSession | null = null;
    media.onStart(() => {
      callSession = new CallSession({
        telephony: media,
        stt,
        llm,
        tts,
        calendar,
        tenant,
        repositories,
        sessionStore,
        fromNumber: '+15550001111',
        toNumber: '+15551234567',
      });
      void callSession.start();
    });

    media.handleMessage(
      JSON.stringify({ event: 'start', start: { callSid: 'CA-e2e-1', streamSid: 'MZ-e2e-1' } }),
    );
    expect(callSession).not.toBeNull();

    // Pump caller audio: 6 utterances x 400ms = 2.4s -> 120 x 20ms frames,
    // yielding to the event loop so turns interleave like a live call.
    for (let i = 0; i < 160; i++) {
      media.handleMessage(mediaMessage());
      await tick();
      await tick();
    }
    await callSession!.waitForClose();

    // Booking happened with the details from the conversation slots.
    expect(calendar.bookings).toHaveLength(1);
    expect(calendar.bookings[0]).toMatchObject({ serviceId: 'cleaning', customerName: 'Jane Doe' });

    // Call record finalized as booked.
    const call = await repositories.calls.getById('demo-dental', 'CA-e2e-1');
    expect(call).toMatchObject({ outcome: 'booked', bookingId: 'mock-booking-1', fromNumber: '+15550001111' });
    expect(call!.endedAt).toBeInstanceOf(Date);

    // Transcript contains both sides of the conversation, in order.
    const transcript = await repositories.transcripts.listByCall('demo-dental', 'CA-e2e-1');
    const text = transcript.map((t) => `${t.role}: ${t.text}`).join('\n');
    expect(text).toContain('user: My name is Jane Doe');
    expect(text).toContain('user: Yes book it');
    expect(text).toContain('assistant:');
    expect(transcript.map((t) => t.turnIndex)).toEqual(transcript.map((_, i) => i));

    // Lead + summary persisted.
    const leads = await repositories.leads.listByTenant('demo-dental');
    expect(leads[0]).toMatchObject({ callerName: 'Jane Doe', serviceNeed: 'cleaning' });
    const summary = await repositories.summaries.getByCall('demo-dental', 'CA-e2e-1');
    expect(summary?.summary).toContain('Jane Doe booked');

    // Agent audio actually went back over the wire in Twilio's format.
    const outbound = sent.map((s) => JSON.parse(s));
    const mediaEvents = outbound.filter((m) => m.event === 'media');
    expect(mediaEvents.length).toBeGreaterThan(10);
    expect(mediaEvents[0].streamSid).toBe('MZ-e2e-1');
    expect(Buffer.from(mediaEvents[0].media.payload, 'base64').length).toBeGreaterThan(0);

    // The agent hung up (closed the stream) after end_call.
    expect(socketClosed).toBe(true);

    // Session state cleaned up.
    expect(await sessionStore.get('CA-e2e-1')).toBeNull();
  }, 15000);

  it('abandoned call: caller hangs up (stop event) before finishing', async () => {
    const socket: MediaSocket = { send: () => {}, close: () => {} };
    const media = new TwilioMediaStreamSession(socket);
    const stt = new MockSttProvider({ utterances: ['My name is Jane Doe'], msPerUtterance: 200 });
    const llm = new MockLlmProvider([
      { text: 'Hi! Who am I speaking with?' },
      { toolCalls: [{ id: 'c1', name: 'update_slot', arguments: { name: 'callerName', value: 'Jane Doe' } }] },
      { text: 'Thanks Jane! What do you need?' },
    ]);
    const repositories = {
      calls: new InMemoryCallRepository(),
      transcripts: new InMemoryTranscriptRepository(),
      leads: new InMemoryLeadRepository(),
      summaries: new InMemoryCallSummaryRepository(),
    };

    let callSession: CallSession | null = null;
    media.onStart(() => {
      callSession = new CallSession({
        telephony: media,
        stt,
        llm,
        tts: new MockTtsProvider({ msPerWord: 5 }),
        calendar: new MockCalendarProvider(),
        tenant,
        repositories,
        sessionStore: new InMemorySessionStore(),
        fromNumber: '+15550002222',
        toNumber: '+15551234567',
      });
      void callSession.start();
    });

    media.handleMessage(JSON.stringify({ event: 'start', start: { callSid: 'CA-e2e-2', streamSid: 'MZ-e2e-2' } }));
    for (let i = 0; i < 30; i++) {
      media.handleMessage(mediaMessage());
      await tick();
      await tick();
    }
    media.handleMessage(JSON.stringify({ event: 'stop' }));
    await callSession!.waitForClose();

    const call = await repositories.calls.getById('demo-dental', 'CA-e2e-2');
    expect(call?.outcome).toBe('abandoned');
    // Partial lead captured with the caller-id as phone fallback.
    const leads = await repositories.leads.listByTenant('demo-dental');
    expect(leads[0]).toMatchObject({ callerName: 'Jane Doe', phoneNumber: '+15550002222' });
  }, 15000);
});
