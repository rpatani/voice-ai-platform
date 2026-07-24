import type { AudioFrame, ITelephonyCallSession } from '@platform/core';
import { getLogger, providerErrorTotal } from '@platform/observability';
import { mulawToPcm16, pcm16ToMulaw } from '@platform/core';

const logger = getLogger({ component: 'adapters-twilio' });

/**
 * Transport abstraction over the WebSocket carrying Twilio Media Stream
 * messages. Keeps this adapter independent of any specific WS library and
 * lets tests drive a session with a plain object.
 */
export interface MediaSocket {
  send(data: string): void;
  close(): void;
}

/** Out-of-band call control that needs the Twilio REST API (not the media WS). */
export interface ITwilioCallControl {
  hangup(callSid: string): Promise<void>;
  transfer(callSid: string, toNumber: string): Promise<void>;
}

export interface StreamStartInfo {
  callSid: string;
  streamSid: string;
  customParameters: Record<string, string>;
}

/** Media stream sample rate: Twilio streams 8kHz μ-law both directions. */
export const TWILIO_SAMPLE_RATE_HZ = 8000;

/**
 * `ITelephonyCallSession` over a Twilio Media Streams WebSocket.
 *
 * The owning server feeds every raw WS text message into `handleMessage`.
 * Inbound `media` events are decoded from base64 μ-law to PCM16 before
 * reaching `onAudio` handlers; outbound frames are encoded back. `clear`
 * implements barge-in by flushing Twilio's outbound audio buffer.
 */
export class TwilioMediaStreamSession implements ITelephonyCallSession {
  private audioHandlers: Array<(frame: AudioFrame) => void> = [];
  private endHandlers: Array<() => void> = [];
  private startHandlers: Array<(info: StreamStartInfo) => void> = [];
  private streamSid = '';
  private callSid = '';
  private startedAtEpochMs = 0;
  private ended = false;

  constructor(
    private readonly socket: MediaSocket,
    private readonly callControl?: ITwilioCallControl,
  ) {}

  get callId(): string {
    return this.callSid;
  }

  /** Fired once the carrier sends the `start` event with call/stream ids. */
  onStart(handler: (info: StreamStartInfo) => void): void {
    this.startHandlers.push(handler);
  }

  onAudio(handler: (frame: AudioFrame) => void): void {
    this.audioHandlers.push(handler);
  }

  onEnd(handler: () => void): void {
    this.endHandlers.push(handler);
  }

  /** Entry point for every raw WebSocket message from Twilio. */
  handleMessage(raw: string): void {
    let message: { event?: string; start?: unknown; media?: unknown; streamSid?: string };
    try {
      message = JSON.parse(raw);
    } catch {
      logger.warn({ raw: raw.slice(0, 200) }, 'twilio: dropping non-JSON media stream message');
      return;
    }

    switch (message.event) {
      case 'start': {
        const start = message.start as {
          callSid?: string;
          streamSid?: string;
          customParameters?: Record<string, string>;
        };
        this.callSid = start?.callSid ?? '';
        this.streamSid = start?.streamSid ?? message.streamSid ?? '';
        this.startedAtEpochMs = Date.now();
        const info: StreamStartInfo = {
          callSid: this.callSid,
          streamSid: this.streamSid,
          customParameters: start?.customParameters ?? {},
        };
        for (const handler of this.startHandlers) handler(info);
        break;
      }
      case 'media': {
        const media = message.media as { payload?: string; timestamp?: string };
        if (!media?.payload) return;
        const mulaw = Buffer.from(media.payload, 'base64');
        const frame: AudioFrame = {
          payload: mulawToPcm16(mulaw),
          sampleRateHz: TWILIO_SAMPLE_RATE_HZ,
          timestampMs: media.timestamp !== undefined
            ? Number(media.timestamp)
            : Date.now() - this.startedAtEpochMs,
        };
        for (const handler of this.audioHandlers) handler(frame);
        break;
      }
      case 'stop': {
        this.fireEnd();
        break;
      }
      default:
        // 'connected', 'mark', 'dtmf', ... - not needed by the engine.
        break;
    }
  }

  /** Should be called by the server when the underlying WS closes. */
  handleSocketClosed(): void {
    this.fireEnd();
  }

  async sendAudio(frame: AudioFrame): Promise<void> {
    if (frame.sampleRateHz !== TWILIO_SAMPLE_RATE_HZ) {
      throw new Error(
        `twilio media streams require ${TWILIO_SAMPLE_RATE_HZ}Hz audio, got ${frame.sampleRateHz}Hz`,
      );
    }
    this.socket.send(
      JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: pcm16ToMulaw(frame.payload).toString('base64') },
      }),
    );
  }

  async clearOutboundAudio(): Promise<void> {
    this.socket.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
  }

  async hangup(): Promise<void> {
    if (this.callControl && this.callSid) {
      try {
        await this.callControl.hangup(this.callSid);
        return;
      } catch (err) {
        providerErrorTotal.add(1, { provider: 'twilio', operation: 'hangup' });
        logger.error({ err, callSid: this.callSid }, 'twilio: REST hangup failed, closing stream instead');
      }
    }
    // Without REST credentials (e.g. simulation), closing the stream ends
    // the <Connect><Stream> verb, which ends the call when it is the last verb.
    this.socket.close();
  }

  async transfer(toNumber: string): Promise<void> {
    if (!this.callControl) {
      throw new Error('twilio: transfer requires REST call control (account credentials) to be configured');
    }
    await this.callControl.transfer(this.callSid, toNumber);
  }

  private fireEnd(): void {
    if (this.ended) return;
    this.ended = true;
    for (const handler of this.endHandlers) handler();
  }
}

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * REST-based call control (hangup / transfer) using Twilio's Calls API
 * directly over `fetch` - no SDK. Injected into media sessions when
 * account credentials are configured.
 */
export class TwilioRestCallControl implements ITwilioCallControl {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async hangup(callSid: string): Promise<void> {
    await this.updateCall(callSid, { Status: 'completed' });
  }

  async transfer(callSid: string, toNumber: string): Promise<void> {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${toNumber}</Dial></Response>`;
    await this.updateCall(callSid, { Twiml: twiml });
  }

  private async updateCall(callSid: string, params: Record<string, string>): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls/${encodeURIComponent(callSid)}.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) {
      providerErrorTotal.add(1, { provider: 'twilio', operation: 'updateCall' });
      throw new Error(`twilio REST updateCall failed: HTTP ${response.status} ${await response.text()}`);
    }
  }
}
