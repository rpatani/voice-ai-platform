import { describe, expect, it, vi } from 'vitest';
import type { AudioFrame } from '@platform/core';
import { pcm16ToMulaw } from '@platform/core';
import { DeepgramTtsProvider } from '../tts-provider.js';

async function collect(iterable: AsyncIterable<AudioFrame>): Promise<AudioFrame[]> {
  const frames: AudioFrame[] = [];
  for await (const frame of iterable) frames.push(frame);
  return frames;
}

describe('DeepgramTtsProvider', () => {
  it('requires an api key', () => {
    expect(() => new DeepgramTtsProvider({ apiKey: '' })).toThrow('apiKey');
  });

  it('streams mulaw 8kHz chunks decoded to PCM16 frames with running timestamps', async () => {
    // Two 40-byte mulaw chunks = 2x 5ms at 8kHz.
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
    const provider = new DeepgramTtsProvider({ apiKey: 'k', fetchImpl });

    const frames = await collect(provider.synthesizeStream('Hello there.'));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.payload.length).toBe(80); // 40 mulaw bytes -> 80 pcm bytes
    expect(frames[0]!.sampleRateHz).toBe(8000);
    expect(frames[0]!.timestampMs).toBe(0);
    expect(frames[1]!.timestampMs).toBe(5); // 40 samples @8kHz = 5ms
  });

  it('requests mulaw 8kHz from the /v1/speak endpoint with the configured model and Token auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Blob([]).stream(), { status: 200 }));
    const provider = new DeepgramTtsProvider({ apiKey: 'secret', model: 'aura-asteria-en', fetchImpl });
    await collect(provider.synthesizeStream('Book me in.'));

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('https://api.deepgram.com/v1/speak?');
    expect(url).toContain('model=aura-asteria-en');
    expect(url).toContain('encoding=mulaw');
    expect(url).toContain('sample_rate=8000');
    expect(init.headers.Authorization).toBe('Token secret');
    expect(JSON.parse(init.body).text).toBe('Book me in.');
  });

  it('defaults to the aura-2 model when none is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Blob([]).stream(), { status: 200 }));
    const provider = new DeepgramTtsProvider({ apiKey: 'k', fetchImpl });
    await collect(provider.synthesizeStream('hi'));
    expect(fetchImpl.mock.calls[0]![0]).toContain('model=aura-2-thalia-en');
  });

  it('does not call the API for empty/whitespace text', async () => {
    const fetchImpl = vi.fn();
    const provider = new DeepgramTtsProvider({ apiKey: 'k', fetchImpl });
    const frames = await collect(provider.synthesizeStream('   '));
    expect(frames).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws a descriptive error on API failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    const provider = new DeepgramTtsProvider({ apiKey: 'k', fetchImpl });
    await expect(collect(provider.synthesizeStream('hi'))).rejects.toThrow('HTTP 429');
  });
});
