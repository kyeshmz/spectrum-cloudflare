import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'artifacts');
const directories = ['', ...(await readdir(join(root, 'packages'), { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}`)];
const packages = [];
for (const directory of directories) {
  const source = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
  if (source.private) continue;
  const tarball = join(artifacts, `${source.name.replace('@', '').replace('/', '-')}-${source.version}.tgz`);
  await access(tarball).catch(() => { throw new Error(`Missing ${tarball}; run pnpm pack:all first`); });
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(manifest.name, source.name);
  assert.equal(manifest.version, source.version);
  assert.equal(manifest.repository.url, 'git+https://github.com/kyeshmz/spectrum-cloudflare.git');
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      assert.ok(!/^(workspace|link|catalog):/.test(version), `${source.name}: unpublished dependency ${name}@${version}`);
    }
  }
  assert.ok(!files.some(file => file.startsWith('package/src/') || file.includes('/node_modules/')));
  assert.ok(files.includes('package/dist/THIRD-PARTY-NOTICES.md'), `${source.name} must ship upstream attribution`);
  packages.push({ directory, name: source.name, tarball, manifest, files });
}

const names = ['@spectrum-cloudflare/api', '@spectrum-cloudflare/webhooks', '@spectrum-cloudflare/imessage', 'spectrum-cloudflare'];
assert.deepEqual(packages.map(pkg => pkg.name).sort(), [...names].sort());
const overrides = Object.fromEntries(packages.filter(pkg => pkg.directory).map(pkg => [pkg.name, `file:${pkg.tarball}`]));
const workspace = `overrides:\n${Object.entries(overrides).map(([name, file]) => `  ${JSON.stringify(name)}: ${JSON.stringify(file)}`).join('\n')}\n`;
const timestamp = '1800000000';
const signedBody = '{"type":"text","text":"packed webhook"}';
const signature = createHmac('sha256', 'packed-secret').update(`v0:${timestamp}:${signedBody}`).digest('hex');

function workerSource(name) {
  const imports = [`import * as sdk from ${JSON.stringify(name)};`];
  let exercise;
  if (name === '@spectrum-cloudflare/api') {
    exercise = `
      let authorization: string | null = null;
      const api = new sdk.SpectrumApi({ projectId: 'p', projectSecret: 'secret',
        fetch: async (input, init) => {
          const request = new Request(input, init);
          authorization = request.headers.get('authorization');
          if (init?.redirect !== 'manual') throw new Error('Management redirect policy changed');
          return Response.json({ succeed: true, data: { users: [], total: 7 } });
        },
      });
      const result = await api.request('GET', '/projects/{projectId}/users/', { query: { limit: 1 } });
      const value = { total: result.total, authorization };
    `;
  } else if (name === '@spectrum-cloudflare/webhooks') {
    exercise = `
      const payload = await sdk.verifyLegacySpectrumWebhook({
        body: ${JSON.stringify(signedBody)}, secret: 'packed-secret', now: 1800000000,
        headers: { 'x-spectrum-timestamp': ${JSON.stringify(timestamp)}, 'x-spectrum-signature': ${JSON.stringify(`v0=${signature}`)} },
      });
      if (!sdk.isNormalizedSpectrumContent(payload) || payload.type !== 'text') throw new Error('Invalid verified content');
      const value = { text: payload.text };
    `;
  } else {
    imports.push(`import { createIMessageRpc } from ${JSON.stringify(`${name}/grpc`)};`);
    imports.push(`import { ChatService } from ${JSON.stringify(`${name}/proto/chat_service`)};`);
    if (name === 'spectrum-cloudflare') {
      imports.push(`import * as imessage from 'spectrum-cloudflare/imessage';`);
      imports.push(`import { SpectrumApi } from 'spectrum-cloudflare/api';`);
      imports.push(`import { verifyStandardWebhook } from 'spectrum-cloudflare/webhooks';`);
    }
    exercise = `
      const expectedCount = 9007199254740995n;
      const fetchPeer: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.endsWith('/photon.imessage.v1.ChatService/GetChatCount')
          || request.headers.get('authorization') !== 'Bearer packed-token'
          || request.headers.get('x-photon-server') !== null
          || init?.redirect !== 'manual') throw new Error('Unexpected gRPC request');
        const bytes = [8];
        for (let remaining = expectedCount; remaining; remaining >>= 7n) {
          bytes.push(Number(remaining & 127n) | (remaining > 127n ? 128 : 0));
        }
        const message = frame(0, new Uint8Array(bytes));
        const trailers = frame(128, new TextEncoder().encode('grpc-status: 0\\r\\n'));
        const body = new Uint8Array(message.length + trailers.length);
        body.set(message); body.set(trailers, message.length);
        return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } });
      };
      const app = await sdk.createSpectrum({ projectId: 'p', projectSecret: 's',
        clients: [{ phone: 'shared', token: 'packed-token', baseUrl: 'https://packed.invalid' }], fetch: fetchPeer,
      });
      let count: bigint;
      try { count = (await (await app.rpc()).chats.getChatCount({})).count; }
      finally { await app.close(); }
      const value = { count: String(count), service: ChatService.typeName,
        sameFactory: sdk.createIMessageRpc === createIMessageRpc,
        ${name === 'spectrum-cloudflare' ? 'sameFacade: sdk.createSpectrum === imessage.createSpectrum, sameApi: sdk.SpectrumApi === SpectrumApi, sameVerifier: sdk.verifyStandardWebhook === verifyStandardWebhook,' : ''}
      };
    `;
  }
  return `${imports.join('\n')}
    function frame(flags: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
      const output = new Uint8Array(bytes.length + 5);
      output[0] = flags;
      new DataView(output.buffer).setUint32(1, bytes.length, false);
      output.set(bytes, 5);
      return output;
    }
    export default { async fetch(): Promise<Response> {
      ${exercise}
      const globals = globalThis as unknown as Record<string, unknown>;
      return Response.json({ exports: Object.keys(sdk).sort(), value,
        Buffer: typeof globals.Buffer, process: typeof globals.process });
    } };
  `;
}

const temporary = await mkdtemp(join(tmpdir(), 'spectrum-packed-'));
const results = [];
try {
  for (const name of names) {
    const pkg = packages.find(item => item.name === name);
    const consumer = join(temporary, name.replace('@', '').replace('/', '-'));
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      name: 'isolated-spectrum-consumer', private: true, type: 'module',
      packageManager: 'pnpm@12.14.0', dependencies: { [name]: `file:${pkg.tarball}` },
    }, null, 2));
    await writeFile(join(consumer, 'pnpm-workspace.yaml'), workspace);
    execFileSync('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: consumer, stdio: 'pipe' });
    await writeFile(join(consumer, 'worker.ts'), workerSource(name));
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], strict: true,
        skipLibCheck: false, noEmit: true, exactOptionalPropertyTypes: true },
      include: ['worker.ts'],
    }));
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(consumer, 'tsconfig.json')], { cwd: consumer, stdio: 'pipe' });
    const publicImports = [name];
    let protobufExports = 0;
    const proto = pkg.manifest.exports['./proto/*'];
    if (proto) {
      const [prefix, suffix] = proto.import.replace(/^\.\//, 'package/').split('*');
      for (const file of pkg.files.filter(file => file.startsWith(prefix) && file.endsWith(suffix))) {
        publicImports.push(`${name}/proto/${file.slice(prefix.length, -suffix.length)}`);
        protobufExports++;
      }
      assert.ok(protobufExports > 0, `${name} must ship its exported protobuf modules`);
    }
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      for (const specifier of ${JSON.stringify(publicImports)}) await import(specifier);
      await assert.rejects(import(${JSON.stringify(`${name}/dist/index.js`)}), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    `], { cwd: consumer, stdio: 'pipe' });

    const bundle = await build({ absWorkingDir: consumer, entryPoints: ['worker.ts'],
      bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
      minify: true, write: false, metafile: true });
    const paths = Object.keys(bundle.metafile.inputs);
    for (const path of paths) {
      assert.ok(!/node:|bun:|@spectrum-ts|advanced-imessage|grpc-js|node-stdlib-browser|unenv/.test(path), `Forbidden runtime dependency: ${path}`);
      assert.ok(!resolve(consumer, path).startsWith(`${root}/src/`), 'Consumer resolved repository source');
      assert.ok(!resolve(consumer, path).startsWith(`${root}/packages/`), 'Consumer resolved a workspace link');
    }
    for (const output of Object.values(bundle.metafile.outputs)) assert.deepEqual(output.imports, []);
    if (name.endsWith('/api') || name.endsWith('/webhooks')) {
      assert.deepEqual(pkg.manifest.dependencies ?? {}, {});
      assert.ok(!paths.some(path => /connectrpc|bufbuild|imessage/.test(path)), `${name} pulled messaging into its browser graph`);
      const installed = await readdir(join(consumer, 'node_modules/.pnpm'));
      assert.ok(!installed.some(path => /connectrpc|bufbuild|imessage/.test(path)), `${name} installed messaging dependencies`);
    }

    const worker = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-07-30', compatibilityFlags: [],
      outboundService: () => { throw new Error('Packed checks must not call real services'); } });
    try {
      const response = await worker.dispatchFetch('https://packed-consumer.invalid/');
      assert.equal(response.status, 200, await response.clone().text());
      const data = await response.json();
      assert.equal(data.Buffer, 'undefined');
      assert.equal(data.process, 'undefined');
      if (name.endsWith('/api')) assert.deepEqual(data.value, { total: 7, authorization: 'Basic cDpzZWNyZXQ=' });
      else if (name.endsWith('/webhooks')) assert.deepEqual(data.value, { text: 'packed webhook' });
      else {
        assert.equal(data.value.count, '9007199254740995');
        assert.equal(data.value.service, 'photon.imessage.v1.ChatService');
        assert.equal(data.value.sameFactory, true);
        if (name === 'spectrum-cloudflare') {
          assert.equal(data.value.sameFacade, true);
          assert.equal(data.value.sameApi, true);
          assert.equal(data.value.sameVerifier, true);
        }
      }
      results.push({ name, exports: data.exports, protobufExports,
        bundleGzipBytes: gzipSync(bundle.outputFiles[0].contents).byteLength,
        typesWithoutNode: true, workerdWithoutNode: true });
      console.log(`${name}: packed types, exports, browser graph, and workerd passed`);
    } finally { await worker.dispose(); }
  }
  const native = results.find(result => result.name === '@spectrum-cloudflare/imessage');
  const umbrella = results.find(result => result.name === 'spectrum-cloudflare');
  assert.equal(umbrella.protobufExports, native.protobufExports);
  await writeFile(join(artifacts, 'packed-verification.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
