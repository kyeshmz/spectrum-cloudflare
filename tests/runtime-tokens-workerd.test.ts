import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { runtimeGrpcPeer } from './fixtures/runtime-grpc-peer.js';

let script: string;
beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/runtime-token-worker.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, minify: true });
  script = result.outputFiles[0]!.text;
});

describe('Stable runtime project token discovery in real workerd', () => {
  it.each(['é', '密'])('uses UTF-8 Basic credentials for %s without btoa Latin-1 encoding', async secret => {
    const authorizations: string[] = [];
    const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-30', outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === 'management.test') {
        expect(request.method).toBe('POST');
        expect(url.pathname).toBe('/projects/project/imessage/tokens');
        authorizations.push(request.headers.get('authorization')!);
        return Response.json({ succeed: true, data: { type: 'shared', token: 'line-token', expiresIn: 60 } });
      }
      expect(request.headers.get('authorization')).toBe('Bearer line-token');
      expect(url.hostname).toBe('imessage.spectrum.photon.codes');
      return runtimeGrpcPeer(request);
    } });
    try {
      const response = await mf.dispatchFetch('https://worker.test', { method: 'POST', body: JSON.stringify({ secret }) });
      expect(await response.json()).toEqual({ ok: true, first: 'sent' });
      expect(authorizations).toEqual([`Basic ${Buffer.from(`project:${secret}`, 'utf8').toString('base64')}`]);
    } finally { await mf.dispose(); }
  });

  it('rejects management redirects instead of following an off-origin Location', async () => {
    const hosts: string[] = [];
    const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-30', outboundService: async (request: Request) => {
      const url = new URL(request.url); hosts.push(url.hostname);
      if (url.hostname === 'redirect-management.test') return new Response(null, { status: 302, headers: { Location: 'https://other-origin.test/tokens' } });
      return Response.json({ succeed: true, data: { type: 'shared', token: 'unexpected', expiresIn: 60 } });
    } });
    try {
      const response = await mf.dispatchFetch('https://worker.test', { method: 'POST', body: JSON.stringify({ secret: '密', redirect: true }) });
      expect(await response.json()).toMatchObject({ ok: false, status: 302, error: expect.stringContaining('redirect rejected') });
      expect(hosts).toEqual(['redirect-management.test']);
    } finally { await mf.dispose(); }
  });

  it('discovers dedicated routing and singleflights an expired token refresh in workerd', async () => {
    let mints = 0;
    const bearer: (string | null)[] = [];
    const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-30', outboundService: async (request: Request) => {
      if (new URL(request.url).hostname === 'management.test') {
        mints++;
        expect(request.headers.get('authorization')).toBe(`Basic ${Buffer.from('project:密', 'utf8').toString('base64')}`);
        return Response.json({ succeed: true, data: { type: 'dedicated', auth: { instance: `line-${mints}` }, numbers: { instance: '+15550001111' }, expiresIn: 1 } });
      }
      bearer.push(request.headers.get('authorization'));
      expect(request.headers.get('x-photon-server')).toBeNull();
      expect(new URL(request.url).hostname).toBe('instance.imsg.photon.codes');
      return runtimeGrpcPeer(request);
    } });
    try {
      const response = await mf.dispatchFetch('https://worker.test', { method: 'POST', body: JSON.stringify({ secret: '密', refresh: true }) });
      expect(await response.json()).toEqual({ ok: true, first: 'sent' });
      expect(mints).toBe(2);
      expect(bearer).toEqual(['Bearer line-1', 'Bearer line-2']);
    } finally { await mf.dispose(); }
  });
});
