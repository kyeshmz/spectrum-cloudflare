import type { NormalizedSpectrumContent } from './webhook-types.js';
export type * from './webhook-types.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): value is string { return typeof value === 'string'; }

function optional(object: Record<string, unknown>, key: string, valid: (value: unknown) => boolean): boolean {
  return !(key in object) || valid(object[key]);
}

function user(value: unknown): boolean {
  return record(value) && string(value.id) && string(value.platform);
}

function reference(value: unknown): boolean {
  return record(value) && string(value.id) && string(value.platform) && string(value.timestamp)
    && optional(value, 'sender', user) && optional(value, 'contentPreview', string);
}

function knownContentType(type: unknown): boolean {
  return type === 'text' || type === 'attachment' || type === 'contact'
    || type === 'richlink' || type === 'reaction' || type === 'group';
}

/**
 * Validates known normalized content fields, then enables ordinary discriminator
 * narrowing. Unknown root content returns false; unknown album-child arms are
 * tolerated. This is validation, not authentication: verify the webhook first.
 */
export function isNormalizedSpectrumContent(value: unknown): value is NormalizedSpectrumContent {
  if (!record(value) || !knownContentType(value.type)) return false;
  // Iteration avoids stack overflow for deeply nested untrusted group content.
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length) {
    const content = pending.pop();
    if (!record(content) || !string(content.type)) return false;
    if (visited.has(content)) continue;
    visited.add(content);
    switch (content.type) {
      case 'text':
        if (!string(content.text)) return false;
        break;
      case 'attachment':
        if (!string(content.id) || !string(content.name) || !string(content.mimeType)
          || !optional(content, 'size', (size) => typeof size === 'number' && Number.isFinite(size))) return false;
        break;
      case 'richlink':
        if (!string(content.url)) return false;
        break;
      case 'reaction':
        if (!string(content.emoji) || !reference(content.target)) return false;
        break;
      case 'contact':
        if (!optional(content, 'name', (name) => record(name)
          && optional(name, 'formatted', string) && optional(name, 'first', string) && optional(name, 'last', string))
          || !optional(content, 'phones', (phones) => Array.isArray(phones) && phones.every((phone: unknown) =>
            record(phone) && string(phone.value) && optional(phone, 'type', string)))
          || !optional(content, 'photo', (photo) => record(photo) && string(photo.mimeType))) return false;
        break;
      case 'group':
        if (!Array.isArray(content.items)) return false;
        for (const item of content.items as unknown[]) {
          if (!record(item) || !string(item.id) || !string(item.platform) || item.direction !== 'inbound'
            || !string(item.timestamp) || !user(item.sender) || !optional(item, 'space', user)) return false;
          pending.push(item.content);
        }
        break;
      // Unknown future child arms satisfy SerializedSpectrumContent's fallback.
      default: break;
    }
  }
  return true;
}

export interface WebhookVerificationOptions {
  /** Exact wire bytes (or UTF-8 text), never JSON.stringify(parsedBody). */
  body: string | Uint8Array | ArrayBuffer;
  headers: HeadersInit;
  secret: string;
  /** Unix seconds. Primarily for deterministic tests; defaults to Date.now()/1000. */
  now?: number;
  /** Absolute past/future tolerance in seconds, defaults to 300. */
  toleranceSeconds?: number;
}

export type WebhookVerificationFailure = 'headers' | 'timestamp' | 'secret' | 'signature' | 'payload';

export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
  constructor(readonly code: WebhookVerificationFailure, message: string) { super(message); }
}

const encoder = new TextEncoder();
function fail(code: WebhookVerificationFailure, message: string): never {
  throw new WebhookVerificationError(code, message);
}

function timestamp(headers: Headers, name: string, options: WebhookVerificationOptions): string {
  const value = headers.get(name);
  if (!value || !/^(0|[1-9]\d*)$/u.test(value)) fail('timestamp', 'Missing or malformed webhook timestamp');
  const seconds = Number(value);
  const now = options.now ?? Date.now() / 1000;
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(now) || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('now must be finite and toleranceSeconds finite and nonnegative');
  }
  if (!Number.isSafeInteger(seconds) || Math.abs(now - seconds) > tolerance) fail('timestamp', 'Webhook timestamp outside tolerance');
  return value;
}

function bytes(body: WebhookVerificationOptions['body']): Uint8Array<ArrayBuffer> {
  if (typeof body === 'string') return encoder.encode(body);
  return new Uint8Array(body instanceof Uint8Array ? body : new Uint8Array(body));
}

function signed(prefix: string, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const head = encoder.encode(prefix);
  const result = new Uint8Array(head.length + body.length);
  result.set(head);
  result.set(body, head.length);
  return result;
}

function base64(value: string, code: 'secret' | 'signature'): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) || !value) {
    fail(code, 'Invalid canonical base64');
  }
  const decoded = atob(value);
  if (btoa(decoded) !== value) fail(code, 'Invalid canonical base64');
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function parse(body: Uint8Array<ArrayBuffer>): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown; }
  catch { return fail('payload', 'Verified webhook body is not UTF-8 JSON'); }
}

/** Legacy Spectrum v0: secret is literal UTF-8, not decoded hex/base64. Returns JSON only after verification. */
export async function verifyLegacySpectrumWebhook(options: WebhookVerificationOptions): Promise<unknown> {
  const headers = new Headers(options.headers);
  const ts = timestamp(headers, 'x-spectrum-timestamp', options);
  const signature = headers.get('x-spectrum-signature');
  if (!signature || !/^v0=[0-9a-f]{64}$/u.test(signature)) fail('headers', 'Expected one lowercase v0=hex signature');
  if (!options.secret) fail('secret', 'Legacy signing secret must not be empty');
  const digest = Uint8Array.from(signature.slice(3).match(/../gu)!, (pair) => Number.parseInt(pair, 16));
  const body = bytes(options.body);
  const key = await crypto.subtle.importKey('raw', encoder.encode(options.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('HMAC', key, digest, signed(`v0:${ts}:`, body))) fail('signature', 'Invalid legacy webhook signature');
  return parse(body);
}

/** Standard Webhooks symmetric v1 only. whsec_ suffix is base64-encoded key bytes. Never falls back to legacy. */
export async function verifyStandardWebhook(options: WebhookVerificationOptions): Promise<unknown> {
  const headers = new Headers(options.headers);
  const ts = timestamp(headers, 'webhook-timestamp', options);
  const id = headers.get('webhook-id');
  const signatures = headers.get('webhook-signature');
  if (!id || /[.\s,\u0000-\u001f\u007f]/u.test(id) || !signatures) fail('headers', 'Missing or malformed Standard Webhooks headers');
  if (!options.secret.startsWith('whsec_')) fail('secret', 'Expected a whsec_ Standard Webhooks secret');
  const secret = base64(options.secret.slice(6), 'secret');
  if (secret.length < 24 || secret.length > 64) fail('secret', 'Standard Webhooks key must be 24–64 bytes');
  const body = bytes(options.body);
  const content = signed(`${id}.${ts}.`, body);
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let verified = false;
  for (const token of signatures.split(' ')) {
    const match = /^(v[0-9]+[a-z]*),([^,]+)$/u.exec(token);
    if (!match) fail('headers', 'Malformed Standard Webhooks signature list');
    if (match[1] !== 'v1') continue; // An unsupported scheme can coexist with a trusted v1 signature.
    const digest = base64(match[2]!, 'signature');
    if (digest.length !== 32) fail('signature', 'Expected a SHA-256 signature');
    if (await crypto.subtle.verify('HMAC', key, digest, content)) verified = true;
  }
  if (!verified) fail('signature', 'No valid Standard Webhooks v1 signature');
  return parse(body);
}
