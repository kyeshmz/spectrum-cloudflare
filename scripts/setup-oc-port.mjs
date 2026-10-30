import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/kyeshmz/oc-port-agent.git';
const revision = '02acab4d72fdb3787cbfff153b5f5ce0e9cff7e6';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = fileURLToPath(new URL('../.oc-port/tool', import.meta.url));
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('oc-port-agent requires Node.js 22 or newer.');

if (!existsSync(directory)) {
  mkdirSync(new URL('../.oc-port/', import.meta.url), { recursive: true });
  run('git', ['clone', '--no-checkout', '--no-tags', repository, directory], root);
  run('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', revision]);
}

if (!existsSync(`${directory}/.git`)
  || git('remote', 'get-url', 'origin') !== repository
  || git('rev-parse', 'HEAD') !== revision
  || git('status', '--porcelain')) {
  throw new Error(`Expected a clean oc-port-agent checkout at ${revision} in ${directory}. Move the existing directory aside before running setup again.`);
}

run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
run('npm', ['run', 'build']);
run(process.execPath, ['dist/src/cli.js', '--help']);
console.log(`Installed oc-port-agent ${revision} in .oc-port/tool. Run pnpm port:check to inspect Spectrum.`);
