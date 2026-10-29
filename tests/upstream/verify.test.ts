/** Adapted from Photon AI, MIT, Copyright (c) 2025 Photon AI.
 * https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/webhook/verify.test.ts
 * Independent signer/constants/titles retained. Verifier returns parsed JSON or throws,
 * instead of {ok,reason}; non-JSON payloads are JSON strings. Bare hex is intentionally absent.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLegacySpectrumWebhook } from '@spectrum-cloudflare/webhooks';

const SECRET = 'whsec_unit_test_secret';
const NOW_SECONDS = 1_700_000_000;
const TOLERANCE_SECONDS = 300;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
// Copied from upstream: independent known-answer signer, not an SDK signing helper.
const sign = (body: Uint8Array, timestamp: number, secret = SECRET): string => {
  const base = Buffer.concat([
    Buffer.from(`v0:${timestamp}:`, 'utf8'),
    Buffer.from(body),
  ]);
  return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
};
const headersFor = (signature: string, timestamp: number): Record<string, string> => ({
  'x-spectrum-signature': signature,
  'x-spectrum-timestamp': String(timestamp),
});

describe('verifySpectrumSignature (upstream legacy contract)', () => {
  it('accepts a correctly signed body', async () => {
    const body = encode('{"event":"messages"}');
    expect(await verifyLegacySpectrumWebhook({ body, headers: headersFor(sign(body, NOW_SECONDS), NOW_SECONDS), secret: SECRET, now: NOW_SECONDS })).toEqual({ event: 'messages' });
  });
  it('rejects a tampered body', async () => {
    const signedBody = encode('"original"');
    const deliveredBody = encode('"tampered!"');
    await expect(verifyLegacySpectrumWebhook({ body: deliveredBody, headers: headersFor(sign(signedBody, NOW_SECONDS), NOW_SECONDS), secret: SECRET, now: NOW_SECONDS })).rejects.toMatchObject({ code: 'signature' });
  });
  it('rejects a wrong secret', async () => {
    const body = encode('"payload"');
    await expect(verifyLegacySpectrumWebhook({ body, headers: headersFor(sign(body, NOW_SECONDS, 'other-secret'), NOW_SECONDS), secret: SECRET, now: NOW_SECONDS })).rejects.toMatchObject({ code: 'signature' });
  });
  it('accepts a timestamp at the edge of the tolerance window', async () => {
    const body = encode('"payload"');
    const timestamp = NOW_SECONDS - TOLERANCE_SECONDS;
    expect(await verifyLegacySpectrumWebhook({ body, headers: headersFor(sign(body, timestamp), timestamp), secret: SECRET, now: NOW_SECONDS })).toBe('payload');
  });
  it('rejects a timestamp just outside the tolerance window', async () => {
    const body = encode('"payload"');
    const timestamp = NOW_SECONDS - TOLERANCE_SECONDS - 1;
    await expect(verifyLegacySpectrumWebhook({ body, headers: headersFor(sign(body, timestamp), timestamp), secret: SECRET, now: NOW_SECONDS })).rejects.toMatchObject({ code: 'timestamp' });
  });
  it.each([
    ['rejects when the signature header is missing', { 'x-spectrum-timestamp': String(NOW_SECONDS) }],
    ['rejects when the timestamp header is missing', { 'x-spectrum-signature': sign(encode('"payload"'), NOW_SECONDS) }],
    ['rejects a non-numeric timestamp header', { 'x-spectrum-signature': sign(encode('"payload"'), NOW_SECONDS), 'x-spectrum-timestamp': 'not-a-number' }],
  ])('%s', async (_title, headers) => {
    await expect(verifyLegacySpectrumWebhook({ body: encode('"payload"'), headers: headers as Record<string, string>, secret: SECRET, now: NOW_SECONDS })).rejects.toThrow();
  });
  it.each([
    ['rejects a non-hex / wrong-length signature without throwing', 'v0=not-hex-zzzz'],
    ['rejects an odd-length hex signature without throwing', 'v0=abc'],
  ])('%s', async (_title, signature) => {
    // Original "without throwing" means no low-level crypto crash; this API deliberately throws a typed verification error.
    await expect(verifyLegacySpectrumWebhook({ body: encode('"payload"'), headers: headersFor(signature!, NOW_SECONDS), secret: SECRET, now: NOW_SECONDS })).rejects.toMatchObject({ code: 'headers' });
  });
  it('throws on an empty secret instead of returning a 401-shaped result', async () => {
    const body = encode('"payload"');
    await expect(verifyLegacySpectrumWebhook({ body, headers: headersFor(sign(body, NOW_SECONDS), NOW_SECONDS), secret: '', now: NOW_SECONDS })).rejects.toMatchObject({ code: 'secret' });
  });
});
