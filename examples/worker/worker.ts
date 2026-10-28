import { createSpectrum, text } from 'spectrum-cloudflare';
import { verifyLegacySpectrumWebhook, WebhookVerificationError } from 'spectrum-cloudflare/webhooks';

export interface Env {
  SPECTRUM_PROJECT_ID: string;
  SPECTRUM_PROJECT_SECRET: string;
  SPECTRUM_WEBHOOK_SECRET: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deliberately narrow: no albums, outgoing echoes, other providers, or raw events.
// A valid signature authenticates bytes; it does not validate their shape.
function inboundText(value: unknown): { spaceId: string; phone: string } | undefined {
  if (!record(value) || value.event !== 'messages' || !record(value.message)) return;
  const message = value.message;
  // Stable's documented event spelling is iMessage; retain lowercase compatibility.
  if ((message.platform !== 'iMessage' && message.platform !== 'imessage') || message.direction !== 'inbound'
    || typeof message.id !== 'string' || !message.id
    || !record(message.content) || message.content.type !== 'text'
    || typeof message.content.text !== 'string' || !record(message.space)) return;
  const { id, phone } = message.space;
  if (typeof id !== 'string' || !id || typeof phone !== 'string' || !phone) return;
  return { spaceId: id, phone };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return new Response('ok');
    if (path !== '/webhook') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    let payload: unknown;
    try {
      // Verify exact bytes BEFORE initializing Spectrum (initialization mints tokens).
      // This endpoint accepts ONLY legacy native normalized Spectrum deliveries.
      payload = await verifyLegacySpectrumWebhook({
        body: await request.arrayBuffer(),
        headers: request.headers,
        secret: env.SPECTRUM_WEBHOOK_SECRET,
      });
    } catch (error) {
      if (error instanceof WebhookVerificationError) return new Response('Invalid webhook', { status: 401 });
      throw error;
    }

    const delivery = inboundText(payload);
    if (!delivery) return new Response('Ignored', { status: 200 });

    const app = await createSpectrum({
      projectId: env.SPECTRUM_PROJECT_ID,
      projectSecret: env.SPECTRUM_PROJECT_SECRET,
    });
    try {
      // Explicit phone preserves the delivery's dedicated/shared line routing.
      const space = await app.space(delivery.spaceId, { phone: delivery.phone });
      await space.send(text('Received — thanks!'));
      return new Response('ok');
    } finally {
      // Runs after ALL work, including send failures, and before returning a 2xx.
      await app.close();
    }
  },
};
