import { describe, expect, it, vi } from 'vitest';
import { SpectrumApi, SpectrumApiError } from '../src/api.js';
import type { SpectrumOperations } from '../src/api.js';
import { spectrumRoutes } from '../src/api-routes.js';
import { readFileSync } from 'node:fs';

const projectId = 'cb8e9229-f333-4918-80e9-47b0a245293c';
const credentials = { projectId, projectSecret: 'secret' };
const envelope = (data: unknown) => Response.json({ succeed: true, data });

describe('SpectrumApi network contract', () => {
  it('uses the exact slash path, UTF-8 Basic credentials, repeated query keys, and fail-closed redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelope({ users: [], total: 0 }));
    const api = new SpectrumApi({ ...credentials, projectSecret: 'sëcret🔑', fetch: fetcher });
    expect(await api.request('GET', '/projects/{projectId}/users/', {
      query: { id: ['first', 'second'], limit: 5, offset: 0, search: '+44 hello' },
    })).toEqual({ users: [], total: 0 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://spectrum.photon.codes/projects/${projectId}/users/?id=first&id=second&limit=5&offset=0&search=%2B44+hello`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from(`${projectId}:sëcret🔑`, 'utf8').toString('base64')}`);
    expect(init?.redirect).toBe('manual');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('serializes typed JSON and automatically fills only the configured project', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelope({ templateId: '42', success: true }));
    const api = new SpectrumApi({ ...credentials, fetch: fetcher });
    const result = await api.request('PATCH', '/projects/{projectId}/whatsapp-business/accounts/{accountId}/templates/{templateId}', {
      path: { accountId: 'acct', templateId: '42' }, body: { messageSendTtlSeconds: 30 },
    });
    const success: true = result.success;
    expect(success).toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://spectrum.photon.codes/projects/${projectId}/whatsapp-business/accounts/acct/templates/42`);
    expect(init?.body).toBe('{"messageSendTtlSeconds":30}');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('never sends credentials on the public redirect and builds a safe credential-free URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'sms:+15551234567' } }));
    const api = new SpectrumApi({ ...credentials, fetch: fetcher });
    expect(api.userRedirectUrl('person', { msg: 'hi + hello' })).toBe('https://spectrum.photon.codes/users/person/redirect?msg=hi+%2B+hello');
    const response = await api.request('GET', '/users/{userId}/redirect', { path: { userId: 'person' } });
    expect(response.headers.get('location')).toBe('sms:+15551234567');
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has('authorization')).toBe(false);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe('manual');
  });

  it.each([300, 301, 302, 303, 304, 305, 307, 308, 399])('rejects management HTTP %s without forwarding credentials or losing diagnostics', async (status) => {
    const rawBody = status === 304 ? '' : 'Use the other host';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(status === 304 ? null : rawBody, {
      status, headers: { Location: 'https://untrusted.invalid/collect', 'x-request-id': 'redirect-request' },
    }));
    const api = new SpectrumApi({ ...credentials, fetch: fetcher });
    const error = await api.request('GET', '/projects/{projectId}/profile').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SpectrumApiError);
    expect(error).toMatchObject({
      name: 'SpectrumApiError', kind: 'http', status, rawBody,
      message: `Spectrum redirect rejected (HTTP ${status})`,
      headers: expect.any(Headers),
    });
    expect((error as SpectrumApiError).headers.get('location')).toBe('https://untrusted.invalid/collect');
    expect((error as SpectrumApiError).headers.get('x-request-id')).toBe('redirect-request');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.any(URL), expect.objectContaining({ redirect: 'manual' }));
  });

  it.each(['.', '..', '%2e%2e', 'a/b', '//evil.test', 'https://evil.test', 'a\\b', 'a?b', 'a#b', ''])('rejects path injection %j before fetch', async (userId) => {
    const fetcher = vi.fn<typeof fetch>();
    const api = new SpectrumApi({ ...credentials, fetch: fetcher });
    await expect(api.request('GET', '/projects/{projectId}/users/{userId}/', { path: { userId } })).rejects.toThrow(TypeError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unrecognized paths even from untyped callers', async () => {
    const api = new SpectrumApi(credentials);
    // @ts-expect-error Not in the pinned API.
    await expect(api.request('GET', 'https://evil.test')).rejects.toThrow('Unknown Spectrum');
  });

  it.each(['http://localhost', 'https://host/path', 'https://user:pass@host', 'https://host?x=1'])('rejects unsafe base URL %s', (baseUrl) => {
    expect(() => new SpectrumApi({ ...credentials, baseUrl })).toThrow(TypeError);
  });

  it('preserves non-JSON HTTP failures and does not retry a write', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<gateway down>', { status: 502, headers: { 'x-request-id': 'req-123' } }));
    const api = new SpectrumApi({ ...credentials, fetch: fetcher });
    try {
      await api.request('POST', '/projects/{projectId}/lines/', { body: { platform: 'imessage' } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SpectrumApiError);
      const failure = error as SpectrumApiError;
      expect(failure.status).toBe(502);
      expect(failure.rawBody).toBe('<gateway down>');
      expect(failure.headers.get('x-request-id')).toBe('req-123');
      expect(failure.kind).toBe('http');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves structured error codes, including failed envelopes on non-2xx', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ succeed: false, data: null, code: 'NO_AVAILABLE_IMESSAGE_LINE', message: 'Pause assignment' }, { status: 503 }));
    const api = new SpectrumApi({ ...credentials, fetch: fetcher });
    await expect(api.request('GET', '/projects/{projectId}/lines/route')).rejects.toMatchObject({ status: 503, code: 'NO_AVAILABLE_IMESSAGE_LINE', message: 'Pause assignment' });
  });

  it.each(['not json', '{}', '[]', '{"succeed":false,"data":null}', '{"succeed":true}'])('rejects malformed success %s', async (raw) => {
    const api = new SpectrumApi({ ...credentials, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(raw)) });
    await expect(api.request('GET', '/projects/{projectId}/')).rejects.toMatchObject({ kind: 'invalid-response', rawBody: raw, status: 200 });
  });

  it('accepts null data for a missing SIP config', async () => {
    const api = new SpectrumApi({ ...credentials, fetch: vi.fn<typeof fetch>().mockResolvedValue(envelope(null)) });
    expect(await api.request('GET', '/projects/{projectId}/voice/sip-inbound/')).toBeNull();
  });

  it('aborts at its finite deadline and propagates caller cancellation', async () => {
    const fetcher: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const api = new SpectrumApi({ ...credentials, fetch: fetcher, timeoutMs: 5 });
    await expect(api.request('GET', '/projects/{projectId}/')).rejects.toMatchObject({ name: 'TimeoutError' });
    const controller = new AbortController();
    const pending = api.request('GET', '/projects/{projectId}/', { signal: controller.signal, timeoutMs: 1000 });
    controller.abort(new Error('caller canceled'));
    await expect(pending).rejects.toThrow('caller canceled');
    controller.abort();
    await expect(api.request('GET', '/projects/{projectId}/', { signal: controller.signal })).rejects.toThrow('caller canceled');
  });

  it.each([0, -1, Infinity, NaN, 2 ** 32])('rejects invalid timeout %s', (timeoutMs) => {
    expect(() => new SpectrumApi({ ...credentials, timeoutMs })).toThrow(RangeError);
  });

  it('pins the complete 54-operation allowlist to the checked-in OpenAPI', () => {
    const spec = JSON.parse(readFileSync(new URL('../spec/spectrum-openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const expected = Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    expect(Object.keys(spectrumRoutes).sort()).toEqual(expected.sort());
    expect(expected).toHaveLength(54);
    const typed: Record<keyof SpectrumOperations, boolean> = spectrumRoutes;
    expect(Object.keys(typed)).toHaveLength(54);
  });
});

// Compile-only assertions: request inputs and results are endpoint-specific.
function typeChecks(api: SpectrumApi) {
  // @ts-expect-error body is required
  void api.request('POST', '/projects/{projectId}/lines/');
  // @ts-expect-error other path parameters are required
  void api.request('GET', '/projects/{projectId}/users/{userId}/');
  // @ts-expect-error query name is required on template deletion
  void api.request('DELETE', '/projects/{projectId}/whatsapp-business/accounts/{accountId}/templates/{templateId}', { path: { accountId: 'a', templateId: 't' } });
  // @ts-expect-error platform is a literal union
  void api.request('POST', '/projects/{projectId}/lines/', { body: { platform: 'voice' } });
  // @ts-expect-error GET has no body
  void api.request('GET', '/projects/{projectId}/', { body: {} });
  // @ts-expect-error configured projectId cannot be overridden
  void api.request('GET', '/projects/{projectId}/users/{userId}/', { path: { userId: 'u', projectId: 'other' } });
  void api.request('GET', '/projects/{projectId}/imessage/').then((result) => {
    const kind: 'shared' | 'dedicated' = result.type;
    // @ts-expect-error endpoint-specific results do not invent fields
    const nope: string = result.users;
    return [kind, nope];
  });
}
void typeChecks;
