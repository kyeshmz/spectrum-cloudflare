import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

let script: string;
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { attachment, attachmentUrl, group, resolveContent }
          from './packages/imessage/src/runtime-content.ts';

        // All constructors execute at module scope, outside a request context.
        const file = attachment(new Uint8Array([1]), { name: 'file.bin' });
        const remote = attachment(new URL('https://example.com/file.bin'));
        const explicit = attachment(new Uint8Array(), { id: 'explicit-id' });
        const invalid = attachment(new Uint8Array(), { id: '' });
        const name = file.name;

        export default {
          async fetch() {
            // Both build-first and plain-property-first access happen in a request.
            const built = await file.build();
            const remoteId = remote.id;
            const grouped = await resolveContent(group('caption', remote));
            let invalidRejected = false;
            try { await invalid.build(); } catch { invalidRejected = true; }
            return Response.json({
              id: built.id, remoteId, name,
              same: built === file && (await file.build()) === file,
              groupedSame: grouped.items[1].content === remote,
              url: attachmentUrl(grouped.items[1].content).href,
              bytes: [...await built.read()],
              explicitId: (await explicit.build()).id,
              invalidRejected,
              hasBuffer: typeof globalThis.Buffer !== 'undefined',
            });
          },
        };
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  script = result.outputFiles[0]!.text;
});

describe('module-scope attachment builders in real workerd', () => {
  it('starts without global randomness and lazily caches request-time ids', async () => {
    const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-30' });
    try {
      const first = await mf.dispatchFetch('https://worker.test');
      expect(first.status).toBe(200);
      const value = await first.json();
      expect(value).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        remoteId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: 'file.bin', same: true, groupedSame: true,
        url: 'https://example.com/file.bin', bytes: [1],
        explicitId: 'explicit-id', invalidRejected: true, hasBuffer: false,
      });
      const second = await mf.dispatchFetch('https://worker.test');
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(value);
    } finally {
      await mf.dispose();
    }
  });
});
