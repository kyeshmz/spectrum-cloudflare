import { describe, expect, it } from 'vitest';
import { isNormalizedSpectrumContent, verifyLegacySpectrumWebhook, verifyStandardWebhook } from '../src/webhooks.js';
import type { NormalizedSpectrumWebhookEvent, SerializedSpectrumContent } from '../src/webhooks.js';

// Independent fixtures: Python stdlib hmac/hashlib, NOT the verifier or a shared signer.
// Standard key bytes = bytes(range(32)); legacy key is literal UTF-8 below.
const body = '{"text":"héllo 🌈","ok":true}';
const now = 1_800_000_000;
const legacySecret = 'a3f8e29b5c7e9b2d5c7e9b2d5c7e9b2d5c7e9b2d5c7e9b2d5c7e9b2d5c7e9b2d';
const standardSecret = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const legacySignature = 'v0=6f6ccc463ca4368ce3493d08bacbeb9dcfae04def710a76bd9ddbbb69f3e052c';
const standardSignature = 'v1,EZnIN1oEhr3xGHWGOkBwNJeMUQlO9rIRLMOWxQZOM50=';
const legacyHeaders = { 'X-Spectrum-Timestamp': String(now), 'X-Spectrum-Signature': legacySignature };
const standardHeaders = { 'webhook-id': 'evt_independent', 'webhook-timestamp': String(now), 'webhook-signature': standardSignature };

describe('legacy Spectrum verifier', () => {
  it('verifies independently signed non-ASCII raw bytes and returns unknown parsed JSON', async () => {
    expect(await verifyLegacySpectrumWebhook({ body: new TextEncoder().encode(body), headers: legacyHeaders, secret: legacySecret, now })).toEqual({ text: 'héllo 🌈', ok: true });
  });

  it('accepts an ArrayBuffer without changing the signed bytes', async () => {
    expect(await verifyLegacySpectrumWebhook({ body: new TextEncoder().encode(body).buffer, headers: legacyHeaders, secret: legacySecret, now })).toEqual(JSON.parse(body));
  });

  it('rejects whitespace changes, wrong secrets, and altered signatures', async () => {
    for (const overrides of [{ body: body + ' ' }, { secret: 'wrong' }, { headers: { ...legacyHeaders, 'X-Spectrum-Signature': 'v0=' + '0'.repeat(64) } }]) {
      await expect(verifyLegacySpectrumWebhook({ body, headers: legacyHeaders, secret: legacySecret, now, ...overrides })).rejects.toMatchObject({ code: 'signature' });
    }
  });

  it.each(['v0=ABC', 'v1=aa', legacySignature.toUpperCase(), legacySignature + ',' + legacySignature])('rejects malformed header %s', async (signature) => {
    await expect(verifyLegacySpectrumWebhook({ body, headers: { ...legacyHeaders, 'X-Spectrum-Signature': signature }, secret: legacySecret, now })).rejects.toMatchObject({ code: 'headers' });
  });

  it('verifies binary bytes before rejecting invalid UTF-8 JSON, not by lossy decoding', async () => {
    const binary = Uint8Array.from([123, 34, 116, 101, 120, 116, 34, 58, 34, 255, 34, 125]);
    await expect(verifyLegacySpectrumWebhook({ body: binary, headers: { ...legacyHeaders, 'X-Spectrum-Signature': 'v0=a8e49e6ea3acd5da82b5501d731eaf700be4b3623cea532bf9bd6623f9d6965f' }, secret: legacySecret, now })).rejects.toMatchObject({ code: 'payload' });
  });
});

describe('Standard Webhooks verifier', () => {
  it('decodes whsec_ key bytes and verifies the independent HMAC fixture', async () => {
    expect(await verifyStandardWebhook({ body, headers: standardHeaders, secret: standardSecret, now })).toEqual(JSON.parse(body));
  });

  it('supports multiple rotation signatures, including an unsupported scheme', async () => {
    const signatures = `v1,${'A'.repeat(43)}= v1a,ignored ${standardSignature}`;
    expect(await verifyStandardWebhook({ body, headers: { ...standardHeaders, 'webhook-signature': signatures }, secret: standardSecret, now })).toEqual(JSON.parse(body));
  });

  it('authenticates ID, timestamp, body, and key independently', async () => {
    for (const overrides of [
      { headers: { ...standardHeaders, 'webhook-id': 'different' } },
      { headers: { ...standardHeaders, 'webhook-timestamp': String(now + 1) } },
      { body: body + '\n' },
      { secret: 'whsec_' + 'A'.repeat(43) + '=' },
    ]) {
      await expect(verifyStandardWebhook({ body, headers: standardHeaders, secret: standardSecret, now, ...overrides })).rejects.toMatchObject({ code: 'signature' });
    }
  });

  it.each(['', 'v1,???', 'v1,YQ==', 'v1,AAAA', 'v1,,AAAA', 'v2,AAAA', 'v1,AA=A', standardSignature + '  ' + standardSignature])('rejects invalid or unsupported signature %j', async (signature) => {
    await expect(verifyStandardWebhook({ body, headers: { ...standardHeaders, 'webhook-signature': signature }, secret: standardSecret, now })).rejects.toThrow();
  });

  it.each(['no_prefix', 'whsec_?', 'whsec_YQ==', 'whsec_' + 'A'.repeat(88), 'whsec_' + 'A'.repeat(42) + 'B='])('rejects invalid secret %j', async (secret) => {
    await expect(verifyStandardWebhook({ body, headers: standardHeaders, secret, now })).rejects.toMatchObject({ code: 'secret' });
  });

  it.each(['id.with.dot', 'two ids', 'duplicate,id'])('rejects ambiguous IDs %j', async (id) => {
    await expect(verifyStandardWebhook({ body, headers: { ...standardHeaders, 'webhook-id': id }, secret: standardSecret, now })).rejects.toMatchObject({ code: 'headers' });
  });

  it('never downgrades when legacy headers are also present', async () => {
    await expect(verifyStandardWebhook({ body, headers: { ...legacyHeaders, ...standardHeaders, 'webhook-signature': 'v1,' + 'A'.repeat(43) + '=' }, secret: standardSecret, now })).rejects.toMatchObject({ code: 'signature' });
  });

  it('authenticates binary bodies before rejecting invalid UTF-8 JSON', async () => {
    const backing = Uint8Array.from([0, 123, 34, 116, 101, 120, 116, 34, 58, 34, 255, 34, 125, 0]);
    await expect(verifyStandardWebhook({ body: backing.subarray(1, 13), headers: { ...standardHeaders, 'webhook-signature': 'v1,sr/6ufCVsi/Lxlu3d+EdNrKhDl0OcCR+SpZLmQfTMTI=' }, secret: standardSecret, now })).rejects.toMatchObject({ code: 'payload' });
  });
});

describe('replay protection for both schemes', () => {
  const cases = [
    { verify: verifyLegacySpectrumWebhook, headers: legacyHeaders, secret: legacySecret, timestamp: 'X-Spectrum-Timestamp' },
    { verify: verifyStandardWebhook, headers: standardHeaders, secret: standardSecret, timestamp: 'webhook-timestamp' },
  ];
  for (const fixture of cases) {
    it(`${fixture.verify.name} checks past and future with strict integer syntax`, async () => {
      for (const clock of [now - 301, now + 301]) {
        await expect(fixture.verify({ body, ...fixture, now: clock })).rejects.toMatchObject({ code: 'timestamp' });
      }
      for (const malformed of ['', 'NaN', 'Infinity', '1800000000.0', '+1800000000', '01800000000', '1800000000,1800000000', '9007199254740992']) {
        await expect(fixture.verify({ body, ...fixture, headers: { ...fixture.headers, [fixture.timestamp]: malformed }, now })).rejects.toMatchObject({ code: 'timestamp' });
      }
      expect(await fixture.verify({ body, ...fixture, now: now + 300 })).toEqual(JSON.parse(body));
      expect(await fixture.verify({ body, ...fixture, now: now - 300 })).toEqual(JSON.parse(body));
      await expect(fixture.verify({ body, ...fixture, now, toleranceSeconds: Infinity })).rejects.toThrow(RangeError);
    });
  }
});

const target = { id: 'target', platform: 'iMessage', timestamp: '2026-10-28T00:00:00Z' };
const albumItem = {
  id: 'child', platform: 'iMessage', direction: 'inbound', timestamp: '2026-10-28T00:00:00Z',
  sender: { id: 'sender', platform: 'iMessage' }, content: { type: 'text', text: 'hello' },
};

describe('validated normalized content narrowing', () => {
  it.each([
    { type: 'text', text: 'hello', future: { allowed: true } },
    { type: 'attachment', id: 'file', name: 'photo', mimeType: 'image/jpeg' },
    { type: 'attachment', id: 'file', name: 'photo', mimeType: 'image/jpeg', size: 123 },
    { type: 'richlink', url: 'https://example.com' },
    { type: 'contact' },
    { type: 'contact', name: {}, phones: [], raw: null },
    { type: 'contact', name: { formatted: 'Ada', first: 'Ada', last: 'Lovelace', future: true }, phones: [{ value: '+15550000000', type: 'mobile', future: true }], photo: { mimeType: 'image/png', future: true }, raw: { provider: 'opaque' } },
    { type: 'reaction', emoji: '👍', target },
    { type: 'reaction', emoji: '👍', target: { ...target, sender: { id: 'user', platform: 'iMessage' }, contentPreview: 'hello' } },
    { type: 'group', items: [] },
    { type: 'group', items: [albumItem] },
    { type: 'group', items: [{ ...albumItem, space: { id: 'space', platform: 'iMessage', phone: 'shared' } }] },
    { type: 'group', items: [{ ...albumItem, content: { type: 'future-provider-content', anyField: ['tolerated'] } }] },
  ])('validates known fields without rejecting permitted extras: %j', (value) => {
    expect(isNormalizedSpectrumContent(value)).toBe(true);
  });

  it.each([
    null, [], true, 'text', {}, { type: 'future-content', text: 'not a known arm' },
    { type: 'text' }, { type: 'text', text: 42 },
    { type: 'attachment', id: 'file', name: 'photo' },
    { type: 'attachment', id: 1, name: 'photo', mimeType: 'image/jpeg' },
    { type: 'attachment', id: 'file', name: null, mimeType: 'image/jpeg' },
    { type: 'attachment', id: 'file', name: 'photo', mimeType: 'image/jpeg', size: '123' },
    { type: 'attachment', id: 'file', name: 'photo', mimeType: 'image/jpeg', size: NaN },
    { type: 'attachment', id: 'file', name: 'photo', mimeType: 'image/jpeg', size: undefined },
    { type: 'richlink', url: null },
    { type: 'reaction', emoji: 7, target },
    { type: 'reaction', emoji: '👍', target: { id: 'id', platform: 'iMessage' } },
    { type: 'reaction', emoji: '👍', target: { ...target, timestamp: 7 } },
    { type: 'reaction', emoji: '👍', target: { ...target, sender: null } },
    { type: 'reaction', emoji: '👍', target: { ...target, sender: { id: 'id' } } },
    { type: 'reaction', emoji: '👍', target: { ...target, contentPreview: 5 } },
    { type: 'contact', name: null },
    { type: 'contact', name: { formatted: 3 } },
    { type: 'contact', name: { first: false } },
    { type: 'contact', name: { last: [] } },
    { type: 'contact', phones: {} },
    { type: 'contact', phones: [null] },
    { type: 'contact', phones: [{ value: 3 }] },
    { type: 'contact', phones: [{ value: '+15550000000', type: null }] },
    { type: 'contact', photo: {} },
    { type: 'contact', photo: { mimeType: 3 } },
    { type: 'group', items: {} },
    { type: 'group', items: [null] },
    { type: 'group', items: [{ ...albumItem, id: 3 }] },
    { type: 'group', items: [{ ...albumItem, direction: 'outbound' }] },
    { type: 'group', items: [{ ...albumItem, timestamp: 7 }] },
    { type: 'group', items: [{ ...albumItem, sender: { id: 'user' } }] },
    { type: 'group', items: [{ ...albumItem, space: null }] },
    { type: 'group', items: [{ ...albumItem, space: { id: 'space' } }] },
    { type: 'group', items: [{ ...albumItem, content: null }] },
    { type: 'group', items: [{ ...albumItem, content: { type: 1 } }] },
    { type: 'group', items: [{ ...albumItem, content: { type: 'text', text: false } }] },
    { type: 'group', items: [{ ...albumItem, content: { type: 'reaction', emoji: '👍', target: { ...target, contentPreview: [] } } }] },
  ])('rejects malformed known fields rather than discriminator-casting: %j', (value) => {
    expect(isNormalizedSpectrumContent(value)).toBe(false);
  });

  it('checks deeply nested groups iteratively instead of overflowing the call stack', () => {
    let content: unknown = { type: 'text', text: 'deep' };
    for (let index = 0; index < 10_000; index++) content = { type: 'group', items: [{ ...albumItem, content }] };
    expect(isNormalizedSpectrumContent(content)).toBe(true);
  });
});

// Compile-only: the unknown fallback cannot be safely narrowed by discriminator
// alone; validation provides a genuinely discriminated known-content view.
function contentTypeChecks(content: SerializedSpectrumContent, unknownContent: unknown) {
  if (content.type === 'text') {
    // @ts-expect-error future/malformed arm overlap means this is unknown until validated
    const unvalidated: string = content.text;
    void unvalidated;
  }
  if (isNormalizedSpectrumContent(content)) {
    if (content.type === 'text') {
      const text: string = content.text;
      void text.toUpperCase();
    }
    if (content.type === 'reaction') {
      const id: string = content.target.id;
      const preview: string | undefined = content.target.contentPreview;
      void [id, preview];
    }
    if (content.type === 'group') {
      const type: string | undefined = content.items[0]?.content.type;
      void type;
    }
  }
  if (isNormalizedSpectrumContent(unknownContent) && unknownContent.type === 'attachment') {
    const mime: string = unknownContent.mimeType;
    const size: number | undefined = unknownContent.size;
    void [mime, size];
  }
}
void contentTypeChecks;

// Public webhook subpath also exposes the normalized event envelope type.
function eventTypeChecks(event: NormalizedSpectrumWebhookEvent): SerializedSpectrumContent {
  const kind: 'messages' = event.event;
  void kind;
  return event.message.content;
}
void eventTypeChecks;
