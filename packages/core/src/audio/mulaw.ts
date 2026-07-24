/**
 * G.711 μ-law codec. Twilio Media Streams carry 8kHz μ-law audio; the rest
 * of the platform works in 16-bit PCM, so the adapter converts at the edge.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** Encode a single PCM16 sample to a μ-law byte. */
export function pcm16ToMulawSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode a single μ-law byte to a PCM16 sample. */
export function mulawToPcm16Sample(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

/** Decode a buffer of μ-law bytes into a PCM16 little-endian buffer. */
export function mulawToPcm16(mulaw: Buffer): Buffer {
  const pcm = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(mulawToPcm16Sample(mulaw[i]!), i * 2);
  }
  return pcm;
}

/** Encode a PCM16 little-endian buffer into μ-law bytes. */
export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const out = Buffer.allocUnsafe(Math.floor(pcm.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = pcm16ToMulawSample(pcm.readInt16LE(i * 2));
  }
  return out;
}
