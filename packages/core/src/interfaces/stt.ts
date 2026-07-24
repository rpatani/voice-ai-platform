import type { AudioFrame } from './telephony.js';

/** A transcript update emitted by the STT engine while it processes audio. */
export interface TranscriptEvent {
  /** Best-guess text for the current utterance so far. */
  text: string;
  /** True once the STT engine considers this utterance complete (end-of-speech). */
  isFinal: boolean;
  /** Confidence score in [0, 1], if the provider exposes one. */
  confidence: number;
  /** Timestamp (ms since session start) this transcript corresponds to. */
  timestampMs: number;
}

/** Audio encoding accepted by `ISpeechToTextProvider.startSession`. */
export type AudioEncoding = 'pcm16' | 'mulaw';

export interface SpeechToTextSessionOptions {
  sampleRateHz: number;
  encoding: AudioEncoding;
  /** BCP-47 language code, e.g. "en-US". Defaults to provider default if omitted. */
  languageCode?: string;
}

/**
 * A live streaming transcription session for one call.
 * Audio is pushed in; transcripts come back asynchronously via `onTranscript`.
 */
export interface ISpeechToTextSession {
  /** Push the next chunk of caller audio into the STT engine. */
  sendAudio(frame: AudioFrame): void;

  /** Register a handler for interim and final transcript events. */
  onTranscript(handler: (event: TranscriptEvent) => void): void;

  /** Register a handler for unrecoverable session errors. */
  onError(handler: (error: Error) => void): void;

  /** Close the session and release any underlying connection. */
  close(): Promise<void>;
}

/**
 * Abstraction over a streaming speech-to-text provider (Deepgram, Whisper
 * streaming, Google STT, ...). Implementations open a provider-specific
 * streaming connection and translate its events into `TranscriptEvent`s.
 */
export interface ISpeechToTextProvider {
  readonly name: string;

  startSession(options: SpeechToTextSessionOptions): Promise<ISpeechToTextSession>;
}
