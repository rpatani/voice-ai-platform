import { describe, expect, it, vi } from 'vitest';
import type { TranscriptEvent } from '@platform/core';
import { DeepgramSttProvider, type SttSocket } from '../provider.js';

function makeFakeSocket() {
  const callbacks = { open: [] as Array<() => void>, message: [] as Array<(d: string) => void>, error: [] as Array<(e: Error) => void>, close: [] as Array<() => void> };
  const sent: Array<Buffer | string> = [];
  let closed = false;
  const socket: SttSocket = {
    send: (data) => sent.push(data),
    close: () => {
      closed = true;
    },
    onOpen: (cb) => callbacks.open.push(cb),
    onMessage: (cb) => callbacks.message.push(cb),
    onError: (cb) => callbacks.error.push(cb),
    onClose: (cb) => callbacks.close.push(cb),
  };
  return {
    socket,
    sent,
    isClosed: () => closed,
    fireOpen: () => callbacks.open.forEach((cb) => cb()),
    fireMessage: (d: string) => callbacks.message.forEach((cb) => cb(d)),
    fireError: (e: Error) => callbacks.error.forEach((cb) => cb(e)),
  };
}

const frame = (byte = 1) => ({ payload: Buffer.alloc(320, byte), sampleRateHz: 8000, timestampMs: 0 });

describe('DeepgramSttProvider', () => {
  it('requires an api key', () => {
    expect(() => new DeepgramSttProvider({ apiKey: '' })).toThrow('apiKey');
  });

  it('builds the live URL from session options', async () => {
    let capturedUrl = '';
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({
      apiKey: 'key',
      model: 'nova-3',
      socketFactory: (url) => {
        capturedUrl = url;
        return fake.socket;
      },
    });
    await provider.startSession({ sampleRateHz: 8000, encoding: 'mulaw', languageCode: 'en-US' });
    expect(capturedUrl).toContain('wss://api.deepgram.com/v1/listen?');
    expect(capturedUrl).toContain('encoding=mulaw');
    expect(capturedUrl).toContain('sample_rate=8000');
    expect(capturedUrl).toContain('model=nova-3');
    expect(capturedUrl).toContain('language=en-US');
  });

  it('buffers audio sent before the socket opens, then flushes', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({ apiKey: 'key', socketFactory: () => fake.socket });
    const session = await provider.startSession({ sampleRateHz: 8000, encoding: 'pcm16' });
    session.sendAudio(frame(1));
    session.sendAudio(frame(2));
    expect(fake.sent).toHaveLength(0);
    fake.fireOpen();
    expect(fake.sent).toHaveLength(2);
    session.sendAudio(frame(3));
    expect(fake.sent).toHaveLength(3);
  });

  it('maps Results messages to TranscriptEvents (speech_final => isFinal)', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({ apiKey: 'key', socketFactory: () => fake.socket });
    const session = await provider.startSession({ sampleRateHz: 8000, encoding: 'mulaw' });
    const events: TranscriptEvent[] = [];
    session.onTranscript((e) => events.push(e));

    fake.fireMessage(JSON.stringify({
      type: 'Results',
      is_final: false,
      speech_final: false,
      start: 1.2,
      channel: { alternatives: [{ transcript: 'book a clean', confidence: 0.8 }] },
    }));
    fake.fireMessage(JSON.stringify({
      type: 'Results',
      is_final: true,
      speech_final: true,
      start: 1.2,
      channel: { alternatives: [{ transcript: 'book a cleaning', confidence: 0.95 }] },
    }));
    // Empty transcripts and non-Results messages are dropped.
    fake.fireMessage(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: '' }] } }));
    fake.fireMessage(JSON.stringify({ type: 'Metadata' }));
    fake.fireMessage('garbage');

    expect(events).toEqual([
      { text: 'book a clean', isFinal: false, confidence: 0.8, timestampMs: 1200 },
      { text: 'book a cleaning', isFinal: true, confidence: 0.95, timestampMs: 1200 },
    ]);
  });

  it('propagates socket errors to onError handlers', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({ apiKey: 'key', socketFactory: () => fake.socket });
    const session = await provider.startSession({ sampleRateHz: 8000, encoding: 'mulaw' });
    const onError = vi.fn();
    session.onError(onError);
    fake.fireError(new Error('boom'));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });

  it('sends CloseStream and closes; ignores audio after close', async () => {
    const fake = makeFakeSocket();
    const provider = new DeepgramSttProvider({ apiKey: 'key', socketFactory: () => fake.socket });
    const session = await provider.startSession({ sampleRateHz: 8000, encoding: 'mulaw' });
    fake.fireOpen();
    await session.close();
    expect(fake.sent).toContain(JSON.stringify({ type: 'CloseStream' }));
    expect(fake.isClosed()).toBe(true);
    session.sendAudio(frame());
    expect(fake.sent).toHaveLength(1); // only the CloseStream message
  });
});
