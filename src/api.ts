import type { SpectrumOperations } from './api-types.js';
export type { SpectrumOperations } from './api-types.js';
import { spectrumRoutes } from './api-routes.js';

export type SpectrumMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type SpectrumPath<M extends SpectrumMethod> = {
  [K in keyof SpectrumOperations]: K extends `${M} ${infer P}` ? P : never;
}[keyof SpectrumOperations];
type Operation<M extends SpectrumMethod, P extends SpectrumPath<M>> =
  `${M} ${P}` extends keyof SpectrumOperations ? SpectrumOperations[`${M} ${P}`] : never;
export type SpectrumRequestOptions<M extends SpectrumMethod, P extends SpectrumPath<M>> =
  Omit<Operation<M, P>, 'response'> & { signal?: AbortSignal; timeoutMs?: number };
export type SpectrumResponse<M extends SpectrumMethod, P extends SpectrumPath<M>> =
  Operation<M, P> extends { response: infer R } ? R : never;
type Arguments<M extends SpectrumMethod, P extends SpectrumPath<M>> =
  {} extends SpectrumRequestOptions<M, P>
    ? [options?: SpectrumRequestOptions<M, P>]
    : [options: SpectrumRequestOptions<M, P>];

export interface SpectrumApiOptions {
  projectId: string;
  projectSecret: string;
  /** HTTPS origin only. Credentials are sent to this explicitly trusted origin. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Positive finite milliseconds; defaults to 30 seconds. */
  timeoutMs?: number;
}

export class SpectrumApiError extends Error {
  override readonly name = 'SpectrumApiError';
  readonly status: number;
  readonly headers: Headers;
  readonly rawBody: string;
  readonly body: unknown;
  readonly code: string | undefined;
  readonly kind: 'http' | 'invalid-response';

  constructor(message: string, response: Response, rawBody: string, body: unknown, kind: 'http' | 'invalid-response') {
    super(message);
    this.status = response.status;
    this.headers = new Headers(response.headers);
    this.rawBody = rawBody;
    this.body = body;
    this.kind = kind;
    this.code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError('timeoutMs must be positive finite milliseconds, at most 2147483647');
  }
  return value;
}

function segment(value: unknown): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\%?#:\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError('Path parameters must be nonempty opaque segments, not URLs or encoded paths');
  }
  return encodeURIComponent(value);
}

function basic(projectId: string, secret: string): string {
  if (projectId.includes(':')) throw new TypeError('projectId must not contain a colon');
  let binary = '';
  for (const byte of new TextEncoder().encode(`${projectId}:${secret}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/** Stable Spectrum project-scoped management API. No retries or background state. */
export class SpectrumApi {
  readonly #origin: string;
  readonly #projectId: string;
  readonly #authorization: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: SpectrumApiOptions) {
    const base = new URL(options.baseUrl ?? 'https://spectrum.photon.codes');
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new TypeError('baseUrl must be an HTTPS origin without credentials, path, query, or fragment');
    }
    segment(options.projectId);
    if (!options.projectSecret) throw new TypeError('projectSecret must not be empty');
    this.#origin = base.origin;
    this.#projectId = options.projectId;
    this.#authorization = basic(options.projectId, options.projectSecret);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = timeout(options.timeoutMs ?? 30_000);
  }

  /** Public URL: no credentials are embedded or sent. The server responds with a messaging deep-link redirect. */
  userRedirectUrl(userId: string, options: { msg?: string } = {}): string {
    const url = new URL(`/users/${segment(userId)}/redirect`, this.#origin);
    if (options.msg !== undefined) url.searchParams.set('msg', options.msg);
    return url.href;
  }

  async request<M extends SpectrumMethod, P extends SpectrumPath<M>>(
    method: M,
    path: P,
    ...args: Arguments<M, P>
  ): Promise<SpectrumResponse<M, P>> {
    const key = `${method} ${path}`;
    if (!Object.hasOwn(spectrumRoutes, key)) throw new TypeError('Unknown Spectrum method/path');
    const authenticated = spectrumRoutes[key as keyof typeof spectrumRoutes];
    const options = (args[0] ?? {}) as {
      path?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    };
    const resolved = path.replace(/\{([^}]+)\}/gu, (_, name: string) =>
      segment(name === 'projectId' ? this.#projectId : options.path?.[name]));
    const url = new URL(resolved, this.#origin);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
    }
    const headers = new Headers({ Accept: 'application/json' });
    if (authenticated) headers.set('Authorization', this.#authorization);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const timeoutMs = timeout(options.timeoutMs ?? this.#timeoutMs);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('Spectrum request timed out', 'TimeoutError')),
      timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method,
        headers,
        // workerd supports follow/manual, not error. Never follow redirects
        // carrying project credentials, and retain the response for diagnostics.
        redirect: 'manual',
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      // Public redirects deliberately bypass envelope decoding and never carry auth.
      if (!authenticated && response.status === 302) return response as SpectrumResponse<M, P>;
      const raw = await response.text();
      let body: unknown;
      try { body = JSON.parse(raw); } catch { body = undefined; }
      if (!response.ok || (response.status >= 300 && response.status < 400)) {
        const message = response.status >= 300 && response.status < 400
          ? `Spectrum redirect rejected (HTTP ${response.status})`
          : isRecord(body) && typeof body.message === 'string' ? body.message : `Spectrum HTTP ${response.status}`;
        throw new SpectrumApiError(message, response, raw, body, 'http');
      }
      if (!isRecord(body) || body.succeed !== true || !Object.hasOwn(body, 'data')) {
        throw new SpectrumApiError('Malformed Spectrum success envelope', response, raw, body, 'invalid-response');
      }
      return body.data as SpectrumResponse<M, P>;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}
