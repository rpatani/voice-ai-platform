import type { AudioFrame, ITextToSpeechProvider, SynthesizeOptions } from '@platform/core';
import { mulawToPcm16 } from '@platform/core';
import { providerErrorTotal, withSpan } from '@platform/observability';

const OUTPUT_SAMPLE_RATE_HZ = 8000;

export interface ElevenLabsOptions {
  apiKey: string;
  /** Default voice used when the tenant doesn't specify one. */
  defaultVoiceId?: string;
  /** ElevenLabs model, e.g. "eleven_flash_v2_5" (lowest latency). */
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Streaming TTS via ElevenLabs' HTTP streaming endpoint (no SDK). Audio is
 * requested as `ulaw_8000` - the native telephony format - and decoded to
 * PCM16 frames as chunks arrive, so playback can start before synthesis
 * finishes.
 */
export class ElevenLabsTtsProvider implements ITextToSpeechProvider {
  readonly name = 'elevenlabs';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ElevenLabsOptions) {
    if (!options.apiKey) throw new Error('elevenlabs: apiKey is required');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *synthesizeStream(text: string, options?: SynthesizeOptions): AsyncIterable<AudioFrame> {
    const voiceId = options?.voiceId ?? this.options.defaultVoiceId;
    if (!voiceId) throw new Error('elevenlabs: no voiceId configured');
    const base = this.options.baseUrl ?? 'https://api.elevenlabs.io';
    const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=ulaw_8000`;

    const response = await withSpan('tts.synthesize.request', async (span) => {
      span.setAttribute('tts.provider', this.name);
      span.setAttribute('tts.text_length', text.length);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'xi-api-key': this.options.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: this.options.model ?? 'eleven_flash_v2_5',
          ...(options?.languageCode ? { language_code: options.languageCode } : {}),
        }),
      });
      if (!res.ok) {
        providerErrorTotal.add(1, { provider: 'elevenlabs', operation: 'synthesize' });
        throw new Error(`elevenlabs: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
      }
      return res;
    });

    if (!response.body) throw new Error('elevenlabs: empty response body');
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
