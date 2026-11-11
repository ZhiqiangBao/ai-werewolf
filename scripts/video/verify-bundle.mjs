/** Offline smoke test against a fresh, bootstrapped temporary project. */
import { cp, mkdir, mkdtemp, readdir, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';

const root = process.cwd(), base = resolve(root, 'data/video-bootstrap-tests');
await mkdir(base, { recursive: true });
const target = await mkdtemp(join(base, 'smoke-'));
for (const file of ['package.json', 'tsconfig.json', 'vitest.config.ts']) await cp(join(root, file), join(target, file));
await cp(join(root, 'packages'), join(target, 'packages'), { recursive: true, filter: (path) => basename(path) !== 'node_modules' });
await cp(join(root, 'scripts/asr'), join(target, 'scripts/asr'), { recursive: true });
// Test-only junctions reuse the checkout's installed dependencies without network access.
await symlink(join(root, 'node_modules'), join(target, 'node_modules'), 'junction');
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try { await symlink(join(root, 'packages', entry.name, 'node_modules'), join(target, 'packages', entry.name, 'node_modules'), 'junction'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const run = (args, cwd) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`${args[0]} failed (${result.status}): ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
run([join(root, 'skills/werewolf-video/scripts/bootstrap.mjs'), `--project=${target}`], root);
const output = run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'packages/session/test/player-video.test.ts', '-t', '合成局贯通'], target);
console.log(output);
console.log(JSON.stringify({ target, test: 'bootstrapped player export → prepare → synthetic TTS → timeline → render → verify', fixture: 'synthetic' }, null, 2));
