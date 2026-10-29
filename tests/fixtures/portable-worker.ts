import { SpectrumApi, SpectrumApiError } from '@spectrum-cloudflare/api';
import {
  verifyLegacySpectrumWebhook,
  verifyStandardWebhook,
  WebhookVerificationError,
} from '@spectrum-cloudflare/webhooks';

// Public, deterministic test credentials only; never contact a Photon endpoint.
const api = new SpectrumApi({
  projectId: 'portable-project',
  projectSecret: 'sëcret🔑',
  baseUrl: 'https://management.invalid',
});

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/management/profile') {
        return Response.json(await api.request('PATCH', '/projects/{projectId}/profile', {
          body: { firstName: 'Worker', lastName: 'Integration' },
        }));
      }
      if (path === '/management/error') {
        return Response.json(await api.request('GET', '/projects/{projectId}/lines/route'));
      }
      if (path === '/legacy' || path === '/standard') {
        const legacy = path === '/legacy';
        const verify = legacy ? verifyLegacySpectrumWebhook : verifyStandardWebhook;
        return Response.json(await verify({
          body: await request.arrayBuffer(),
          headers: request.headers,
          secret: legacy
            ? 'a3f8e29b5c7e9b2d5c7e9b2d5c7e9b2d5c7e9b2d5c7e9b2d5c7e9b2d5c7e9b2d'
            : 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
          now: 1_800_000_000,
        }));
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof SpectrumApiError) {
        return Response.json({
          name: error.name,
          kind: error.kind,
          status: error.status,
          code: error.code,
          message: error.message,
          body: error.body,
          rawBody: error.rawBody,
          requestId: error.headers.get('x-request-id'),
        }, { status: error.status });
      }
      if (error instanceof WebhookVerificationError) {
        return Response.json({ name: error.name, code: error.code }, { status: 401 });
      }
      throw error;
    }
  },
};
