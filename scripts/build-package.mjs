// Build-time only. Packages are compiled in workspace dependency order.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.argv[2] ?? '.');
await rm(join(directory, 'dist'), { recursive: true, force: true });
const result = spawnSync('tsc', ['-p', join(directory, 'tsconfig.build.json')], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await writeFile(join(directory, 'dist/THIRD-PARTY-NOTICES.md'),
  await readFile(join(root, 'THIRD-PARTY-NOTICES.md')));
if (directory === root) {
  // Derive compatibility forwarders from the pinned descriptor inventory;
  // never maintain another list of protobuf modules or copy implementation.
  const snapshot = JSON.parse(await readFile(join(root, 'packages/imessage/proto/snapshot.json'), 'utf8'));
  const output = join(root, 'dist/generated/photon/imessage/v1');
  await mkdir(output, { recursive: true });
  for (const path of Object.keys(snapshot.sha256)) {
    const match = /^photon\/imessage\/v1\/([^/]+)\.proto$/.exec(path);
    if (!match) continue;
    const content = `export * from '@spectrum-cloudflare/imessage/proto/${match[1]}';\n`;
    await writeFile(join(output, `${match[1]}_pb.js`), content);
    await writeFile(join(output, `${match[1]}_pb.d.ts`), content);
  }
}
