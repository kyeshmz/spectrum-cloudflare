import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['worker.ts'],
  outfile: 'dist/worker.js',
  minify: true,
  sourcemap: true,
});
