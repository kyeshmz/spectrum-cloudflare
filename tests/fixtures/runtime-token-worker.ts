import { createSpectrum, SpectrumApiError } from '../../src/index.js';

export default {
  async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { secret: string; refresh?: boolean; redirect?: boolean };
    let app: Awaited<ReturnType<typeof createSpectrum>> | undefined;
    try {
      app = await createSpectrum({ projectId: 'project', projectSecret: input.secret,
        baseUrl: input.redirect ? 'https://redirect-management.test' : 'https://management.test',
      });
      const first = await app.space('any;-;peer').send('first');
      if (input.refresh) {
        await new Promise(resolve => setTimeout(resolve, 850));
        await Promise.all(Array.from({ length: 5 }, () => app!.rpc()));
        await app.space('any;-;peer').send('second');
      }
      return Response.json({ ok: true, first: first.id });
    } catch (error) {
      return Response.json({ ok: false, error: String(error), status: error instanceof SpectrumApiError ? error.status : null });
    } finally { await app?.close(); }
  },
};
