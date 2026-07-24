import type { AudioFrame } from './telephony.js';

export interface SynthesizeOptions {
  /** Provider-specific voice identifier. Resolved from tenant config. */
  voiceId?: string;
  /** BCP-47 language code, for providers that support multilingual voices. */
  languageCode?: string;
}

/**
 * Abstraction over a streaming text-to-speech provider (ElevenLabs, Azure
 * Speech, Piper, ...). The conversation engine feeds it sentence-sized
 * chunks of the LLM's reply as soon as they're available, and streams the
 * resulting audio back to the caller via `ITelephonyCallSession.sendAudio`.
 */
export interface ITextToSpeechProvider {
  readonly name: string;

  /** Stream synthesized audio for the given text. */
  synthesizeStream(text: string, options?: SynthesizeOptions): AsyncIterable<AudioFrame>;
}
