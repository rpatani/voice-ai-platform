import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@platform/core';
import { MockSttProvider } from '../mock-stt.js';

// 100ms of 8kHz PCM16 audio.
const frame100ms = { payload: Buffer.alloc(1600), sampleRateHz: 8000, timestampMs: 0 };

describe('MockSttProvider', () => {
  it('emits scripted utterances after enough audio arrives', async () => {
    const provider = new MockSttProvider({ utterances: ['hello', 'a cleaning please'], msPerUtterance: 300 });
    const session = await provider.startSession({ sampleRateHz: 8000, encoding: 'pcm16' });
    const events: TranscriptEvent[] = [];
    session.onTranscript((e) => events.push(e));

    session.sendAudio(frame100ms);
    session.sendAudio(frame100ms);
    expect(events).toHaveLength(0);
    session.sendAudio(frame100ms); // 300ms reached
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: 'hello', isFinal: true });

    for (let i = 0; i < 3; i++) session.sendAudio(frame100ms);
    expect(events).toHaveLength(2);
    expect(events[1]!.text).toBe('a cleaning please');

    // No more scripted utterances: further audio emits nothing.
    for (let i = 0; i < 5; i++) session.sendAudio(frame100ms);
    expect(events).toHaveLength(2);
  });

  it('counts mulaw audio duration correctly (1 byte per sample)', async () => {
    const provider = new MockSttProvider({ utterances: ['hi'], msPerUtterance: 200 });
    const session = await provider.startSession({ sampleRateHz: 8000, encoding: 'mulaw' });
    const events: TranscriptEvent[] = [];
    session.onTranscript((e) => events.push(e));
    // 1600 mulaw bytes @8kHz = 200ms
    session.sendAudio({ payload: Buffer.alloc(1600), sampleRateHz: 8000, timestampMs: 0 });
    expect(events).toHaveLength(1);
  });

  it('supports manual emit and error injection, and ignores audio after close', async () => {
    const provider = new MockSttProvider();
    await provider.startSession({ sampleRateHz: 8000, encoding: 'pcm16' });
    const session = provider.sessions[0]!;
    const events: TranscriptEvent[] = [];
    const errors: Error[] = [];
    session.onTranscript((e) => events.push(e));
    session.onError((e) => errors.push(e));

    session.emit({ text: 'injected', isFinal: true, confidence: 1, timestampMs: 0 });
    session.emitError(new Error('stt down'));
    expect(events[0]!.text).toBe('injected');
    expect(errors[0]!.message).toBe('stt down');

    await session.close();
    session.sendAudio(frame100ms);
    expect(events).toHaveLength(1);
  });
});
