import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { createSpectrum as umbrella, SpectrumApi as umbrellaApi } from 'spectrum-cloudflare';
import { createSpectrum as standalone } from '@spectrum-cloudflare/imessage';
import { Spectrum, imessage } from '@spectrum-cloudflare/imessage';
import { Spectrum as umbrellaSpectrum } from 'spectrum-cloudflare';
import * as providerShim from 'spectrum-cloudflare/providers/imessage';
import { SpectrumApi } from '@spectrum-cloudflare/api';
import { createIMessageRpc as umbrellaRpc } from 'spectrum-cloudflare/grpc';
import { createIMessageRpc } from '@spectrum-cloudflare/imessage/grpc';
import { MessageService as umbrellaService, type SendTextMessageRequest as UmbrellaRequest } from 'spectrum-cloudflare/proto/message_service';
import { MessageService, type SendTextMessageRequest } from '@spectrum-cloudflare/imessage/proto/message_service';

it('preserves umbrella identities and typed public protobuf and gRPC subpaths', () => {
  expect(umbrella).toBe(standalone);
  expect(umbrellaSpectrum).toBe(Spectrum);
  expect(providerShim.imessage).toBe(imessage);
  expect(providerShim.Spectrum).toBe(Spectrum);
  expect(umbrellaApi).toBe(SpectrumApi);
  expect(umbrellaRpc).toBe(createIMessageRpc);
  expect(umbrellaService).toBe(MessageService);
  // This assignment is checked by check-types, not just the runtime test runner.
  const preserveType = (request: UmbrellaRequest): SendTextMessageRequest => request;
  expect(preserveType).toBeTypeOf('function');
});

it('resolves every protobuf descriptor through both public namespaces without duplicated implementations', async () => {
  const snapshot = JSON.parse(await readFile('packages/imessage/proto/snapshot.json', 'utf8')) as { sha256: Record<string, string> };
  const modules = Object.keys(snapshot.sha256).flatMap((path) => {
    const match = /^photon\/imessage\/v1\/([^/]+)\.proto$/.exec(path);
    return match ? [match[1]!] : [];
  });
  expect(modules.length).toBeGreaterThan(0);
  for (const name of modules) {
    const directSpecifier = `@spectrum-cloudflare/imessage/proto/${name}`;
    const umbrellaSpecifier = `spectrum-cloudflare/proto/${name}`;
    const direct = await import(/* @vite-ignore */ directSpecifier);
    const forwarded = await import(/* @vite-ignore */ umbrellaSpecifier);
    expect(Object.keys(forwarded)).toEqual(Object.keys(direct));
    for (const key of Object.keys(direct)) expect(forwarded[key]).toBe(direct[key]);
  }
});

it.each(['api', 'webhooks'])('%s is a self-contained Web API package without the iMessage dependency graph', async (domain) => {
  const bundle = await build({
    stdin: {
      contents: `import * as sdk from '@spectrum-cloudflare/${domain}';
        export default { fetch() { return Response.json({ exports: Object.keys(sdk), Buffer: typeof globalThis.Buffer, process: typeof globalThis.process }); } };`,
      resolveDir: process.cwd(),
    },
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, metafile: true,
  });
  for (const path of Object.keys(bundle.metafile!.inputs)) {
    if (path === '<stdin>') continue;
    expect(path).not.toMatch(/node_modules|packages\/imessage|packages\/(?:api|webhooks)\/dist\/generated/);
    expect(path).toContain(`packages/${domain}/dist/`);
  }
  const worker = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-07-30', compatibilityFlags: [] });
  try {
    const result = await (await worker.dispatchFetch('https://boundary.test')).json();
    expect(result).toEqual({
      exports: expect.arrayContaining(domain === 'api' ? ['SpectrumApi', 'SpectrumApiError'] : ['verifyStandardWebhook', 'verifyLegacySpectrumWebhook']),
      Buffer: 'undefined', process: 'undefined',
    });
  } finally { await worker.dispose(); }
});

it.each([
  '@spectrum-cloudflare/api/dist/api.js',
  '@spectrum-cloudflare/api/src/api.ts',
  '@spectrum-cloudflare/webhooks/dist/webhook-types.js',
  '@spectrum-cloudflare/imessage/dist/runtime.js',
  '@spectrum-cloudflare/imessage/src/runtime.ts',
  'spectrum-cloudflare/dist/index.js',
])('denies private import %s', async (specifier) => {
  await expect(import(/* @vite-ignore */ specifier)).rejects.toThrow();
  expect(() => import.meta.resolve(specifier)).toThrow();
});

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sources(join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []))).flat();
}

it('enforces source ownership, public cross-package imports, declared dependencies, and an acyclic workspace graph', async () => {
  const packages = ['.', 'packages/api', 'packages/webhooks', 'packages/imessage'];
  const manifests = await Promise.all(packages.map(async (directory) => ({
    directory: resolve(directory),
    ...JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string> },
  })));
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const edges = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
    edges.set(manifest.name, new Set([...dependencies].filter((name) => byName.has(name))));
    for (const file of await sources(join(manifest.directory, 'src'))) {
      // Include type-only dependencies too (unlike a bundled runtime graph).
      // The browser bundling tests independently validate runtime resolution.
      const source = await readFile(file, 'utf8');
      const imports = [...source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        if (specifier.startsWith('.')) {
          const local = relative(join(manifest.directory, 'src'), resolve(dirname(file), specifier));
          expect(local.startsWith('..') || isAbsolute(local), `ownership reachthrough from ${file}: ${specifier}`).toBe(false);
        } else {
          const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
          expect(dependencies.has(name), `undeclared runtime/type dependency from ${file}: ${specifier}`).toBe(true);
          if (byName.has(name)) expect(() => import.meta.resolve(specifier)).not.toThrow();
        }
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function walk(name: string): void {
    expect(visiting.has(name), `workspace dependency cycle at ${name}`).toBe(false);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of edges.get(name) ?? []) walk(dependency);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of byName.keys()) walk(name);
});
