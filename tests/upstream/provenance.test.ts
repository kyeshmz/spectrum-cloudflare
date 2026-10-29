import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '../upstream-manifest.json' with { type: 'json' };

describe('upstream provenance (local bookkeeping, not a compatibility scenario)', () => {
  it('pins immutable source identities and existing port destinations', async () => {
    expect(manifest.repository).toBe('https://github.com/photon-hq/spectrum-ts');
    expect(manifest.revision).toBe('d9e39089dc3d1c6f4536826f5ca50798856eecab');
    expect(new Set(manifest.sources.map(source => source.path)).size).toBe(manifest.sources.length);
    for (const source of manifest.sources) {
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
      if ('portedTo' in source) {
        expect(await readFile(new URL(source.portedTo!, import.meta.url), 'utf8')).toContain('Photon AI');
      }
    }
  });
  // Optional source-audit mode; normal tests never need a checkout, network or upstream dependency.
  const checkout = process.env.SPECTRUM_UPSTREAM_CHECKOUT;
  if (checkout) {
    for (const source of manifest.sources) {
      it(`matches pinned upstream source hash: ${source.path}`, async () => {
        const bytes = await readFile(resolve(checkout, source.path));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
      });
    }
  }
});
