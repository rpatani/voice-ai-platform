import type { AudioFrame, ITextToSpeechProvider, SynthesizeOptions } from '@platform/core';

export interface MockTtsOptions {
  /** Simulated speech duration per word, in ms. */
  msPerWord?: number;
  /** Frame size emitted, in ms. */
  frameMs?: number;
  sampleRateHz?: number;
}

/**
 * Silent TTS for tests and simulation mode: emits silence frames whose
 * total duration is proportional to the text length, so orchestration
 * timing (playback, barge-in) behaves realistically without an API.
 */
export class MockTtsProvider implements ITextToSpeechProvider {
  readonly name = 'mock';
  /** Every text passed to synthesizeStream, for assertions. */
  readonly synthesized: string[] = [];

  private readonly msPerWord: number;
  private readonly frameMs: number;
  private readonly sampleRateHz: number;

  constructor(options: MockTtsOptions = {}) {
    this.msPerWord = options.msPerWord ?? 100;
    this.frameMs = options.frameMs ?? 20;
    this.sampleRateHz = options.sampleRateHz ?? 8000;
  }

  async *synthesizeStream(text: string, _options?: SynthesizeOptions): AsyncIterable<AudioFrame> {
    this.synthesized.push(text);
    const words = text.split(/\s+/).filter(Boolean).length || 1;
    const totalMs = words * this.msPerWord;
    const samplesPerFrame = Math.round((this.sampleRateHz * this.frameMs) / 1000);
    const frameCount = Math.max(1, Math.round(totalMs / this.frameMs));
    for (let i = 0; i < frameCount; i++) {
      yield {
        payload: Buffer.alloc(samplesPerFrame * 2),
        sampleRateHz: this.sampleRateHz,
        timestampMs: i * this.frameMs,
      };
    }
  }
}
