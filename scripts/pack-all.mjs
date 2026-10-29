// Called after the full check. Normal pnpm packing rewrites workspace:* to versions.
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(output, { recursive: true });
for (const directory of ['packages/api', 'packages/webhooks', 'packages/imessage', '.']) {
  const result = spawnSync('pnpm', ['--dir', directory, 'pack', '--ignore-scripts', '--pack-destination', output], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
