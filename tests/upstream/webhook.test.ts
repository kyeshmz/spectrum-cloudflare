/** Adapted from Photon AI, MIT, Copyright (c) 2025 Photon AI.
 * https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/core/test/webhook/spectrum.test.ts
 * Same signed-delivery/401 scenarios; Web Request is the only facade overload.
 * Also repeats these scenarios for Standard Webhooks (a local extension, not upstream coverage).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSpectrum } from '@spectrum-cloudflare/imessage';

const SECRET = 'unit-test-secret-32-bytes-minimum!';
const envelope = (value: string) => ({ event: 'messages', space: { id: 's1', platform: 'imessage' }, message: {
  id: 'm1', platform: 'imessage', direction: 'inbound', timestamp: '2026-06-12T10:00:00.000Z',
  sender: { id: 'u1', platform: 'imessage' }, content: { type: 'text', text: value },
} });
function sign(value: string, scheme: 'legacy' | 'standard', secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(envelope(value));
  const headers = scheme === 'legacy' ? {
    'x-spectrum-timestamp': String(timestamp),
    'x-spectrum-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
  } : {
    'webhook-id': 'evt_upstream', 'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${createHmac('sha256', secret).update(`evt_upstream.${timestamp}.${body}`).digest('base64')}`,
  };
  return new Request('https://example.com/webhook', { method: 'POST', headers: headers as Record<string, string>, body });
}

for (const scheme of ['legacy', 'standard'] as const) {
  describe(`spectrum.webhook (upstream scenarios; ${scheme})`, () => {
    const withSpectrum = async () => createSpectrum({ projectId: 'project', projectSecret: 'secret',
      clients: [{ phone: 'shared', token: 'line', baseUrl: 'https://grpc.test' }],
      webhook: { scheme, secret: scheme === 'legacy' ? SECRET : `whsec_${Buffer.from(SECRET).toString('base64')}` },
    });
    it('verifies, deserializes, and delivers a signed message', async () => {
      const app = await withSpectrum();
      try {
        const received: unknown[] = [];
        const result = await app.webhook(sign('hello there', scheme), (space, message) => {
          received.push(message);
          expect(space.platform).toBe('imessage');
          expect(message.direction).toBe('inbound');
          expect(message.content).toEqual({ type: 'text', text: 'hello there' });
        });
        expect(result.status).toBe(200); expect(received).toHaveLength(1);
      } finally { await app.close(); }
    });
    it('rejects a bad signature with 401 and never calls the handler', async () => {
      const app = await withSpectrum();
      try {
        let called = false;
        const result = await app.webhook(sign('hi', scheme, 'the-wrong-secret'), () => { called = true; });
        expect(result.status).toBe(401); expect(called).toBe(false);
      } finally { await app.close(); }
    });
    it('rejects an expired timestamp with 401', async () => {
      const app = await withSpectrum();
      try {
        let called = false;
        const result = await app.webhook(sign('hi', scheme, SECRET, Math.floor(Date.now() / 1000) - 1000), () => { called = true; });
        expect(result.status).toBe(401); expect(called).toBe(false);
      } finally { await app.close(); }
    });
    it('delivers identically through a Web Request', async () => {
      const app = await withSpectrum();
      try {
        let content: unknown;
        const response = await app.webhook(sign('via request', scheme), (_space, message) => { content = message.content; });
        expect(response.status).toBe(200);
        expect(content).toEqual({ type: 'text', text: 'via request' });
      } finally { await app.close(); }
    });
  });
}
