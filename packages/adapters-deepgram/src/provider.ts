import { WebSocket } from 'ws';
import type {
  AudioFrame,
  ISpeechToTextProvider,
  ISpeechToTextSession,
  SpeechToTextSessionOptions,
  TranscriptEvent,
} from '@platform/core';
import { getLogger, providerErrorTotal, withSpan } from '@platform/observability';

const logger = getLogger({ component: 'adapters-deepgram' });

/**
 * Socket abstraction so the Deepgram session can be unit-tested without a
 * network connection. The default factory opens a real `ws` WebSocket with
 * `Authorization: Token <key>`.
 */
export interface SttSocket {
  send(data: Buffer | string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
}

export type SttSocketFactory = (url: string, apiKey: string) => SttSocket;

const defaultSocketFactory: SttSocketFactory = (url, apiKey) => {
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (cb) => ws.on('open', cb),
    onMessage: (cb) => ws.on('message', (raw) => cb(raw.toString())),
    onError: (cb) => ws.on('error', cb),
    onClose: (cb) => ws.on('close', () => cb()),
  };
};

export interface DeepgramOptions {
  apiKey: string;
  /** Deepgram model, e.g. "nova-3". */
  model?: string;
  /** Override the API endpoint (testing / self-hosted). */
  baseUrl?: string;
  socketFactory?: SttSocketFactory;
}

/** Shape of Deepgram's live transcription result messages (fields we use). */
interface DeepgramResultMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
}

class DeepgramSession implements ISpeechToTextSession {
  private transcriptHandlers: Array<(event: TranscriptEvent) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private open = false;
  private closed = false;
  private pending: Buffer[] = [];

  constructor(private readonly socket: SttSocket) {
    socket.onOpen(() => {
      this.open = true;
      for (const chunk of this.pending) socket.send(chunk);
      this.pending = [];
    });
    socket.onMessage((raw) => this.handleMessage(raw));
    socket.onError((err) => {
      providerErrorTotal.add(1, { provider: 'deepgram', operation: 'stream' });
      for (const handler of this.errorHandlers) handler(err);
    });
    socket.onClose(() => {
      this.open = false;
    });
  }

  sendAudio(frame: AudioFrame): void {
    if (this.closed) return;
    if (this.open) {
      this.socket.send(frame.payload);
    } else {
      this.pending.push(frame.payload);
    }
  }

  onTranscript(handler: (event: TranscriptEvent) => void): void {
    this.transcriptHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.open) this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    } finally {
      this.socket.close();
    }
  }

  private handleMessage(raw: string): void {
    let message: DeepgramResultMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      logger.warn('deepgram: dropping non-JSON message');
      return;
    }
    if (message.type !== 'Results') return;
    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript ?? '';
    if (text === '') return;
    const event: TranscriptEvent = {
      text,
      // speech_final marks end-of-utterance (endpointing); is_final alone
      // just means this segment won't be revised.
      isFinal: message.speech_final === true,
      confidence: alternative?.confidence ?? 0,
      timestampMs: Math.round((message.start ?? 0) * 1000),
    };
    for (const handler of this.transcriptHandlers) handler(event);
  }
}

/**
 * Streaming STT via Deepgram's live WebSocket API (no SDK). One WebSocket
 * per call; audio in, interim/final `TranscriptEvent`s out.
 */
export class DeepgramSttProvider implements ISpeechToTextProvider {
  readonly name = 'deepgram';
  private readonly socketFactory: SttSocketFactory;

  constructor(private readonly options: DeepgramOptions) {
    if (!options.apiKey) throw new Error('deepgram: apiKey is required');
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
  }

  async startSession(options: SpeechToTextSessionOptions): Promise<ISpeechToTextSession> {
    return withSpan('stt.startSession', async (span) => {
      span.setAttribute('stt.provider', this.name);
      const params = new URLSearchParams({
        encoding: options.encoding === 'mulaw' ? 'mulaw' : 'linear16',
        sample_rate: String(options.sampleRateHz),
        channels: '1',
        model: this.options.model ?? 'nova-3',
        interim_results: 'true',
        endpointing: '300',
        punctuate: 'true',
      });
      if (options.languageCode) params.set('language', options.languageCode);
      const base = this.options.baseUrl ?? 'wss://api.deepgram.com';
      const url = `${base}/v1/listen?${params.toString()}`;
      return new DeepgramSession(this.socketFactory(url, this.options.apiKey));
    });
  }
}
