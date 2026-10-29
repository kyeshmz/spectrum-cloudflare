/** Adapted from Photon AI, MIT, Copyright (c) 2025 Photon AI.
 * https://github.com/photon-hq/spectrum-ts/blob/d9e39089dc3d1c6f4536826f5ca50798856eecab/packages/spectrum-ts/test/providers-shims.test.ts
 * Same export-identity loop, applied only to the three Workers packages, not upstream providers.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import * as umbrella from 'spectrum-cloudflare';
import * as imessage from '@spectrum-cloudflare/imessage';
import * as api from '@spectrum-cloudflare/api';
import * as webhooks from '@spectrum-cloudflare/webhooks';
import * as imessageShim from 'spectrum-cloudflare/imessage';
import * as apiShim from 'spectrum-cloudflare/api';
import * as webhooksShim from 'spectrum-cloudflare/webhooks';

describe('Workers package shims (upstream export-identity contract)', () => {
  for (const [key, shim, provider] of [
    ['imessage', imessageShim, imessage], ['api', apiShim, api], ['webhooks', webhooksShim, webhooks],
  ] as const) {
    it(`${key}: forwards every export of the provider package`, () => {
      expect(Object.keys(shim).sort()).toEqual(Object.keys(provider).sort());
      for (const name of Object.keys(provider)) {
        expect((shim as Record<string, unknown>)[name]).toBe((provider as Record<string, unknown>)[name]);
        expect((umbrella as Record<string, unknown>)[name]).toBe((provider as Record<string, unknown>)[name]);
      }
    });
  }
});

// Same first two assertions from upstream imessage-package-boundary.test.ts, renamed scope.
// Node transport/local-provider installation tests are intentionally NOT ported.
describe('iMessage package boundary (upstream)', () => {
  const readManifest = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as { dependencies?: Record<string, string> };
  it('keeps local iMessage out of the batteries-included package', async () => {
    const manifest = await readManifest('../../package.json');
    expect(manifest.dependencies).toHaveProperty('@spectrum-cloudflare/imessage');
    expect(manifest.dependencies).not.toHaveProperty('@spectrum-ts/imessage-local');
  });
  it('keeps imessage-kit out of the cloud provider', async () => {
    const manifest = await readManifest('../../packages/imessage/package.json');
    expect(manifest.dependencies).not.toHaveProperty('@photon-ai/imessage-kit');
    expect(manifest.dependencies).not.toHaveProperty('better-sqlite3');
  });
});
