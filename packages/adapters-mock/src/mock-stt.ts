import type {
  AudioFrame,
  ISpeechToTextProvider,
  ISpeechToTextSession,
  SpeechToTextSessionOptions,
  TranscriptEvent,
} from '@platform/core';

export interface MockSttOptions {
  /** Scripted caller utterances, emitted in order. */
  utterances?: string[];
  /**
   * How much audio (ms) must arrive before the next scripted utterance is
   * emitted as a final transcript. Simulates a caller speaking for that long.
   */
  msPerUtterance?: number;
  /** Confidence attached to emitted transcripts. */
  confidence?: number;
}

export class MockSttSession implements ISpeechToTextSession {
  private transcriptHandlers: Array<(event: TranscriptEvent) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private accumulatedMs = 0;
  private totalMs = 0;
  private utteranceIndex = 0;
  private closed = false;

  constructor(
    private readonly options: Required<MockSttOptions>,
    private readonly sessionOptions: SpeechToTextSessionOptions,
  ) {}

  sendAudio(frame: AudioFrame): void {
    if (this.closed) return;
    const bytesPerSample = this.sessionOptions.encoding === 'pcm16' ? 2 : 1;
    const frameMs = (frame.payload.length / bytesPerSample / this.sessionOptions.sampleRateHz) * 1000;
    this.accumulatedMs += frameMs;
    this.totalMs += frameMs;
    if (this.accumulatedMs >= this.options.msPerUtterance && this.utteranceIndex < this.options.utterances.length) {
      this.accumulatedMs = 0;
      const text = this.options.utterances[this.utteranceIndex++]!;
      this.emit({ text, isFinal: true, confidence: this.options.confidence, timestampMs: Math.round(this.totalMs) });
    }
  }

  /** Directly inject a transcript event (test convenience). */
  emit(event: TranscriptEvent): void {
    for (const handler of this.transcriptHandlers) handler(event);
  }

  /** Directly inject an error (test convenience). */
  emitError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  onTranscript(handler: (event: TranscriptEvent) => void): void {
    this.transcriptHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Deterministic scripted STT for tests and simulation mode: instead of
 * transcribing audio it emits pre-configured utterances, one per
 * `msPerUtterance` of received audio - as if the caller said them.
 */
export class MockSttProvider implements ISpeechToTextProvider {
  readonly name = 'mock';
  /** Sessions created so far, exposed for test assertions/driving. */
  readonly sessions: MockSttSession[] = [];

  constructor(private readonly options: MockSttOptions = {}) {}

  async startSession(options: SpeechToTextSessionOptions): Promise<ISpeechToTextSession> {
    const session = new MockSttSession(
      {
        utterances: this.options.utterances ?? [],
        msPerUtterance: this.options.msPerUtterance ?? 1000,
        confidence: this.options.confidence ?? 0.95,
      },
      options,
    );
    this.sessions.push(session);
    return session;
  }
}
