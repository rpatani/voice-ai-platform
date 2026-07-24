/**
 * Abstraction over the telephony/carrier layer (e.g. Twilio Media Streams).
 *
 * Implementations adapt a specific carrier's webhook + bidirectional audio
 * protocol to this provider-agnostic shape. The conversation engine never
 * talks to Twilio (or any other carrier) directly - only through this
 * interface, so swapping carriers is a new adapter + config change.
 */

/** A single chunk of raw audio, normalized to 16-bit PCM mono by the adapter. */
export interface AudioFrame {
  /** Raw PCM16 mono samples. */
  payload: Buffer;
  /** Sample rate of `payload`, e.g. 8000 or 16000. */
  sampleRateHz: number;
  /** Timestamp (ms since call start) this frame corresponds to. */
  timestampMs: number;
}

/** Metadata describing an inbound call as reported by the carrier webhook. */
export interface InboundCallContext {
  /** Carrier-specific unique call identifier (e.g. Twilio CallSid). */
  callId: string;
  /** Caller's phone number in E.164 format. */
  fromNumber: string;
  /** The number the caller dialed - used for tenant resolution. */
  toNumber: string;
}

/**
 * Bidirectional audio + control channel for a single in-progress call.
 * One instance is created per call by the telephony adapter.
 */
export interface ITelephonyCallSession {
  readonly callId: string;

  /** Register a handler invoked for every inbound audio frame from the caller. */
  onAudio(handler: (frame: AudioFrame) => void): void;

  /** Register a handler invoked when the caller hangs up or the carrier ends the stream. */
  onEnd(handler: () => void): void;

  /** Send a frame of synthesized audio back to the caller. */
  sendAudio(frame: AudioFrame): Promise<void>;

  /**
   * Stop sending any currently-queued outbound audio immediately.
   * Used for barge-in: if the caller starts speaking while the agent
   * is still talking, the agent should go silent right away.
   */
  clearOutboundAudio(): Promise<void>;

  /** Gracefully end the call from the agent side. */
  hangup(): Promise<void>;

  /** Transfer the call to a human agent / external number, if supported. */
  transfer(toNumber: string): Promise<void>;
}

/**
 * Entry point implemented by each carrier adapter (e.g. TwilioTelephonyProvider).
 * The HTTP/WebSocket layer in the app uses this to bridge a real carrier
 * connection into an `ITelephonyCallSession`.
 */
export interface ITelephonyProvider {
  readonly name: string;

  /**
   * Build the response body the carrier expects from the inbound-call
   * webhook in order to open a bidirectional media stream to `streamUrl`.
   * For Twilio this is a TwiML document; other carriers may differ.
   */
  buildStreamResponse(streamUrl: string): string;

  /** Parse a carrier webhook payload into a normalized call context. */
  parseInboundCall(rawPayload: unknown): InboundCallContext;
}
