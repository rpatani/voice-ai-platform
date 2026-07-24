import type { AudioFrame, ITextToSpeechProvider, SynthesizeOptions } from '@platform/core';
import { mulawToPcm16 } from '@platform/core';
import { providerErrorTotal, withSpan } from '@platform/observability';

const OUTPUT_SAMPLE_RATE_HZ = 8000;

export interface DeepgramTtsOptions {
  apiKey: string;
  /**
   * Deepgram Aura voice model, e.g. "aura-2-thalia-en" or "aura-asteria-en".
   * The "voice" in Deepgram's TTS is selected via the model name, so it is a
   * provider-construction option rather than a per-utterance one.
   */
  model?: string;
  /** Override the API endpoint (testing / self-hosted). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Streaming TTS via Deepgram Aura's HTTP `/v1/speak` endpoint (no SDK).
 *
 * Audio is requested as `mulaw` at 8 kHz - the native telephony format,
 * identical to what the STT side and Twilio Media Streams use - and decoded
 * to PCM16 frames as chunks arrive so playback can start before synthesis
 * finishes. This is the free-tier-friendly default TTS: it shares the same
 * Deepgram credential/free credit as the STT adapter.
 */
export class DeepgramTtsProvider implements ITextToSpeechProvider {
  readonly name = 'deepgram';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DeepgramTtsOptions) {
    if (!options.apiKey) throw new Error('deepgram-tts: apiKey is required');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *synthesizeStream(text: string, _options?: SynthesizeOptions): AsyncIterable<AudioFrame> {
    if (text.trim() === '') return;
    const base = this.options.baseUrl ?? 'https://api.deepgram.com';
    const params = new URLSearchParams({
      model: this.options.model ?? 'aura-2-thalia-en',
      encoding: 'mulaw',
      sample_rate: String(OUTPUT_SAMPLE_RATE_HZ),
      container: 'none',
    });
    const url = `${base}/v1/speak?${params.toString()}`;

    const response = await withSpan('tts.synthesize.request', async (span) => {
      span.setAttribute('tts.provider', this.name);
      span.setAttribute('tts.model', this.options.model ?? 'aura-2-thalia-en');
      span.setAttribute('tts.text_length', text.length);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        providerErrorTotal.add(1, { provider: 'deepgram', operation: 'synthesize' });
        throw new Error(`deepgram-tts: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
      }
      return res;
    });

    if (!response.body) throw new Error('deepgram-tts: empty response body');
    const reader = response.body.getReader();
    let timestampMs = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const mulaw = Buffer.from(value);
        yield {
          payload: mulawToPcm16(mulaw),
          sampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
          timestampMs,
        };
        timestampMs += (mulaw.length / OUTPUT_SAMPLE_RATE_HZ) * 1000;
      }
    } finally {
      reader.releaseLock();
    }
  }
}
