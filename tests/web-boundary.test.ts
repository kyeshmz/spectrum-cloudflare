import { builtinModules } from 'node:module';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';

it('bundles every root export as ordinary browser ESM and loads without Node globals in workerd', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import * as sdk from './src/index.ts';
        export default {
          fetch() {
            return Response.json({
              exports: Object.keys(sdk).sort(),
              Buffer: typeof globalThis.Buffer,
              process: typeof globalThis.process,
            });
          },
        };
      `,
      resolveDir: process.cwd(),
      sourcefile: 'web-boundary-worker.js',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    metafile: true,
  });

  const forbidden = /(?:^|[/\\])(?:node:|bun:)|@spectrum-ts[/+]core|@grpc[/+]grpc-js|(?:^|[/\\])grpc-js(?:[/\\]|$)|@photon-ai[/+]advanced-imessage/;
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
  const inputs = Object.entries(bundle.metafile!.inputs);
  expect(inputs.some(([path]) => path.endsWith('src/index.ts'))).toBe(true);
  for (const [path, input] of inputs) {
    expect(path, 'forbidden runtime dependency in browser module graph').not.toMatch(forbidden);
    for (const dependency of input.imports) {
      const original = dependency.original ?? dependency.path;
      expect(original, `runtime import from ${path}`).not.toMatch(forbidden);
      expect(builtins.has(original.replace(/^node:/, '')), `Node builtin imported by ${path}: ${original}`).toBe(false);
      expect(dependency.external, `unbundled runtime import from ${path}`).not.toBe(true);
    }
  }
  for (const output of Object.values(bundle.metafile!.outputs)) {
    expect(output.imports, 'Worker must not depend on external runtime modules').toEqual([]);
  }

  const worker = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    outboundService: () => new Response('Boundary smoke test must not access the network', { status: 500 }),
  });
  try {
    const response = await worker.dispatchFetch('https://worker.test/boundary');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      exports: expect.arrayContaining(['SpectrumApi', 'verifyLegacySpectrumWebhook', 'verifyStandardWebhook']),
      Buffer: 'undefined',
      process: 'undefined',
    });
  } finally {
    await worker.dispose();
  }
});
