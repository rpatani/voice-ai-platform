import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundCallContext, ITelephonyProvider } from '@platform/core';

/**
 * Twilio implementation of `ITelephonyProvider`. Uses no Twilio SDK: the
 * inbound webhook is a form-encoded POST, the stream response is a small
 * TwiML document, and request authenticity is HMAC-SHA1 per
 * https://www.twilio.com/docs/usage/security#validating-requests.
 */
export class TwilioTelephonyProvider implements ITelephonyProvider {
  readonly name = 'twilio';

  buildStreamResponse(streamUrl: string): string {
    const escaped = streamUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      '  <Connect>',
      `    <Stream url="${escaped}" />`,
      '  </Connect>',
      '</Response>',
    ].join('\n');
  }

  parseInboundCall(rawPayload: unknown): InboundCallContext {
    const params = normalizePayload(rawPayload);
    const callId = params['CallSid'];
    const fromNumber = params['From'];
    const toNumber = params['To'];
    if (!callId || !fromNumber || !toNumber) {
      throw new Error('invalid Twilio webhook payload: missing CallSid/From/To');
    }
    return { callId, fromNumber, toNumber };
  }

  /**
   * Validate the X-Twilio-Signature header for a form-encoded webhook:
   * HMAC-SHA1(authToken, url + sortedKey1 + value1 + ...) base64-encoded.
   */
  validateSignature(authToken: string, signature: string, url: string, params: Record<string, string>): boolean {
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
    const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'base64');
    } catch {
      return false;
    }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
}

function normalizePayload(rawPayload: unknown): Record<string, string> {
  if (typeof rawPayload === 'string') {
    return Object.fromEntries(new URLSearchParams(rawPayload));
  }
  if (rawPayload instanceof URLSearchParams) {
    return Object.fromEntries(rawPayload);
  }
  if (rawPayload && typeof rawPayload === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawPayload)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  throw new Error('invalid Twilio webhook payload: expected form-encoded body');
}
