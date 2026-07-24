import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  TwilioTelephonyProvider,
  TwilioMediaStreamSession,
  TwilioRestCallControl,
  TWILIO_SAMPLE_RATE_HZ,
  mulawToPcm16,
  pcm16ToMulaw,
  pcm16ToMulawSample,
  mulawToPcm16Sample,
  type MediaSocket,
} from '../index.js';

describe('mulaw codec', () => {
  it('encodes silence to 0xFF and decodes it back to ~0', () => {
    expect(pcm16ToMulawSample(0)).toBe(0xff);
    expect(mulawToPcm16Sample(0xff)).toBe(0);
  });

  it('round-trips samples within quantization error', () => {
    for (const sample of [-32000, -12345, -100, 0, 100, 500, 12345, 32000]) {
      const decoded = mulawToPcm16Sample(pcm16ToMulawSample(sample));
      // μ-law is logarithmic: error grows with amplitude, ~3% relative.
      expect(Math.abs(decoded - sample)).toBeLessThanOrEqual(Math.max(16, Math.abs(sample) * 0.04));
    }
  });

  it('round-trips buffers preserving length (2 pcm bytes per mulaw byte)', () => {
    const pcm = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
    const mulaw = pcm16ToMulaw(pcm);
    expect(mulaw.length).toBe(160);
    expect(mulawToPcm16(mulaw).length).toBe(320);
  });
});

describe('TwilioTelephonyProvider', () => {
  const provider = new TwilioTelephonyProvider();

  it('builds TwiML with the stream URL escaped', () => {
    const twiml = provider.buildStreamResponse('wss://example.com/media?a=1&b=2');
    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('<Stream url="wss://example.com/media?a=1&amp;b=2" />');
  });

  it('parses a form-encoded webhook payload', () => {
    const ctx = provider.parseInboundCall('CallSid=CA123&From=%2B15550001111&To=%2B15551234567&Direction=inbound');
    expect(ctx).toEqual({ callId: 'CA123', fromNumber: '+15550001111', toNumber: '+15551234567' });
  });

  it('parses an already-decoded object payload', () => {
    const ctx = provider.parseInboundCall({ CallSid: 'CA9', From: '+1', To: '+2' });
    expect(ctx.callId).toBe('CA9');
  });

  it('rejects payloads missing required fields', () => {
    expect(() => provider.parseInboundCall({ From: '+1' })).toThrow('missing CallSid');
    expect(() => provider.parseInboundCall(42)).toThrow('expected form-encoded');
  });

  it('validates a correct signature and rejects a tampered one', () => {
    const authToken = 'test-token';
    const url = 'https://example.com/twilio/voice';
    const params = { CallSid: 'CA123', From: '+15550001111', To: '+15551234567' };
    const data = url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join('');
    const signature = createHmac('sha1', authToken).update(data).digest('base64');

    expect(provider.validateSignature(authToken, signature, url, params)).toBe(true);
    expect(provider.validateSignature(authToken, signature, url, { ...params, From: '+15559999999' })).toBe(false);
    expect(provider.validateSignature('wrong-token', signature, url, params)).toBe(false);
    expect(provider.validateSignature(authToken, 'garbage!!', url, params)).toBe(false);
  });
});

function makeSocket(): MediaSocket & { sent: string[]; closed: boolean } {
  const sent: string[] = [];
  return {
    sent,
    closed: false,
    send(data: string) {
      sent.push(data);
    },
    close() {
      this.closed = true;
    },
  };
}

const START_MSG = JSON.stringify({
  event: 'start',
  start: { callSid: 'CA123', streamSid: 'MZ456', customParameters: { tenantId: 'demo-dental' } },
});

describe('TwilioMediaStreamSession', () => {
  it('fires onStart with call/stream ids and exposes callId', () => {
    const session = new TwilioMediaStreamSession(makeSocket());
    const onStart = vi.fn();
    session.onStart(onStart);
    session.handleMessage(START_MSG);
    expect(onStart).toHaveBeenCalledWith({
      callSid: 'CA123',
      streamSid: 'MZ456',
      customParameters: { tenantId: 'demo-dental' },
    });
    expect(session.callId).toBe('CA123');
  });

  it('decodes inbound media to PCM16 frames', () => {
    const session = new TwilioMediaStreamSession(makeSocket());
    const frames: Array<{ payload: Buffer; sampleRateHz: number; timestampMs: number }> = [];
    session.onAudio((f) => frames.push(f));
    session.handleMessage(START_MSG);
    const mulawPayload = Buffer.from([0xff, 0xff, 0x00, 0x80]).toString('base64');
    session.handleMessage(JSON.stringify({ event: 'media', media: { payload: mulawPayload, timestamp: '120' } }));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.length).toBe(8);
    expect(frames[0]!.sampleRateHz).toBe(TWILIO_SAMPLE_RATE_HZ);
    expect(frames[0]!.timestampMs).toBe(120);
  });

  it('encodes outbound audio as base64 mulaw media events', async () => {
    const socket = makeSocket();
    const session = new TwilioMediaStreamSession(socket);
    session.handleMessage(START_MSG);
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(1000, 0);
    pcm.writeInt16LE(-1000, 2);
    await session.sendAudio({ payload: pcm, sampleRateHz: 8000, timestampMs: 0 });
    const sent = JSON.parse(socket.sent[0]!);
    expect(sent.event).toBe('media');
    expect(sent.streamSid).toBe('MZ456');
    expect(Buffer.from(sent.media.payload, 'base64').length).toBe(2);
  });

  it('rejects outbound audio at the wrong sample rate', async () => {
    const session = new TwilioMediaStreamSession(makeSocket());
    await expect(
      session.sendAudio({ payload: Buffer.alloc(2), sampleRateHz: 16000, timestampMs: 0 }),
    ).rejects.toThrow('8000Hz');
  });

  it('sends a clear event for barge-in', async () => {
    const socket = makeSocket();
    const session = new TwilioMediaStreamSession(socket);
    session.handleMessage(START_MSG);
    await session.clearOutboundAudio();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ event: 'clear', streamSid: 'MZ456' });
  });

  it('fires onEnd exactly once across stop + socket close', () => {
    const session = new TwilioMediaStreamSession(makeSocket());
    const onEnd = vi.fn();
    session.onEnd(onEnd);
    session.handleMessage(JSON.stringify({ event: 'stop' }));
    session.handleSocketClosed();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed and unknown messages', () => {
    const session = new TwilioMediaStreamSession(makeSocket());
    const onAudio = vi.fn();
    session.onAudio(onAudio);
    session.handleMessage('not json');
    session.handleMessage(JSON.stringify({ event: 'mark' }));
    session.handleMessage(JSON.stringify({ event: 'media' })); // no payload
    expect(onAudio).not.toHaveBeenCalled();
  });

  it('closes the socket on hangup without call control', async () => {
    const socket = makeSocket();
    const session = new TwilioMediaStreamSession(socket);
    await session.hangup();
    expect(socket.closed).toBe(true);
  });

  it('throws on transfer without call control, delegates with it', async () => {
    const noControl = new TwilioMediaStreamSession(makeSocket());
    await expect(noControl.transfer('+15559876543')).rejects.toThrow('transfer requires REST');

    const control = { hangup: vi.fn(), transfer: vi.fn().mockResolvedValue(undefined) };
    const session = new TwilioMediaStreamSession(makeSocket(), control);
    session.handleMessage(START_MSG);
    await session.transfer('+15559876543');
    expect(control.transfer).toHaveBeenCalledWith('CA123', '+15559876543');
  });
});

describe('TwilioRestCallControl', () => {
  it('POSTs a Dial TwiML update with basic auth on transfer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const control = new TwilioRestCallControl('AC1', 'token', fetchImpl);
    await control.transfer('CA123', '+15559876543');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Calls/CA123.json');
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(decodeURIComponent(init.body)).toContain('<Dial>+15559876543</Dial>');
  });

  it('throws on non-2xx responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const control = new TwilioRestCallControl('AC1', 'bad', fetchImpl);
    await expect(control.hangup('CA123')).rejects.toThrow('HTTP 401');
  });
});
