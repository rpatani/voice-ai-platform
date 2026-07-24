import { describe, expect, it, vi } from 'vitest';
import type { AudioFrame } from '@platform/core';
import { pcm16ToMulaw } from '@platform/core';
import { ElevenLabsTtsProvider } from '../provider.js';

async function collect(iterable: AsyncIterable<AudioFrame>): Promise<AudioFrame[]> {
  const frames: AudioFrame[] = [];
  for await (const frame of iterable) frames.push(frame);
  return frames;
}

describe('ElevenLabsTtsProvider', () => {
  it('requires an api key and a voice id', async () => {
    expect(() => new ElevenLabsTtsProvider({ apiKey: '' })).toThrow('apiKey');
    const provider = new ElevenLabsTtsProvider({ apiKey: 'k' });
    await expect(collect(provider.synthesizeStream('hi'))).rejects.toThrow('no voiceId');
  });

  it('streams ulaw_8000 chunks decoded to PCM16 frames with running timestamps', async () => {
    // Two 80-byte mulaw chunks = 2x 10ms at 8kHz.
    const pcmSource = Buffer.alloc(160);
    const mulawBytes = pcm16ToMulaw(pcmSource);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(mulawBytes.subarray(0, 40));
        controller.enqueue(mulawBytes.subarray(40, 80));
        controller.close();
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    const provider = new ElevenLabsTtsProvider({ apiKey: 'k', defaultVoiceId: 'voice-1', fetchImpl });

    const frames = await collect(provider.synthesizeStream('Hello there.'));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.payload.length).toBe(80); // 40 mulaw bytes -> 80 pcm bytes
    expect(frames[0]!.sampleRateHz).toBe(8000);
    expect(frames[0]!.timestampMs).toBe(0);
    expect(frames[1]!.timestampMs).toBe(5); // 40 samples @8kHz = 5ms

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1/stream?output_format=ulaw_8000');
    expect(init.headers['xi-api-key']).toBe('k');
    expect(JSON.parse(init.body).text).toBe('Hello there.');
  });

  it('prefers the per-call voiceId over the default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Blob([]).stream(), { status: 200 }));
    const provider = new ElevenLabsTtsProvider({ apiKey: 'k', defaultVoiceId: 'default-voice', fetchImpl });
    await collect(provider.synthesizeStream('hi', { voiceId: 'tenant-voice' }));
    expect(fetchImpl.mock.calls[0]![0]).toContain('/text-to-speech/tenant-voice/');
  });

  it('throws a descriptive error on API failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 429 }));
    const provider = new ElevenLabsTtsProvider({ apiKey: 'k', defaultVoiceId: 'v', fetchImpl });
    await expect(collect(provider.synthesizeStream('hi'))).rejects.toThrow('HTTP 429');
  });
});
