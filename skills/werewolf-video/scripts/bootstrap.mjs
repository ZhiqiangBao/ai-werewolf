import { readFile, readdir, mkdir, copyFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join, sep } from 'node:path';
const arg = process.argv.slice(2).find((s) => s.startsWith('--project='));
if (!arg) throw Error('Supply --project=ABSOLUTE_REPOSITORY_PATH');
const root = await realpath(resolve(arg.slice(10))), pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'ai-werewolf') throw Error('This bundle targets the ai-werewolf repository schema');
// Player video re-derives its source from the game projection; never install a
// pipeline that would later discover that this authorization capability is missing.
const required = [
  ['packages/session/src/player-video.ts', /export\s+function\s+buildPlayerVideo\s*\(/],
  ['packages/session/scripts/export-video.ts', /--player-seat=/],
  ['packages/engine/src/index.ts', /\bprojectSeat\b/],
  ['packages/protocol/src/index.ts', /\bbuildVideoScript\b/],
  ['packages/session/src/secret.ts', /\bSecretBox\b/],
  ['packages/session/src/asr.ts', /export\s+async\s+function\s+transcribeAudio\s*\(/],
  ['packages/session/src/asr.ts', /export\s+async\s+function\s+ensureLocalAsrReady\s*\(/],
  ['scripts/asr/service.mjs', /server\.py/],
  ['scripts/asr/server.py', /class\s+PythonSocketGuard\b/],
  ['scripts/asr/register.py', /def\s+register\s*\(/],
  ['scripts/asr/runtime-manifest.v0.4.1.json', /"release"\s*:\s*"v0\.4\.1"/],
];
for (const [file, marker] of required) {
  let source;
  try { source = await readFile(join(root, file), 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw Error(`Incompatible game repository: missing ${file}. Update the game with authorized player-video export and ASR workflow support before bootstrap; no files were installed.`);
  }
  if (!marker.test(source)) throw Error(`Incompatible game repository: ${file} lacks required video capability. Update the game before bootstrap; no files were installed.`);
}
const target = join(root, 'scripts', 'video'); await mkdir(target, { recursive: true });
const checkedTarget = await realpath(target);
if (!checkedTarget.startsWith(root + sep)) throw Error('Pipeline directory resolves outside the intended repository');
const source = fileURLToPath(new URL('../assets/pipeline/', import.meta.url));
let added = 0, kept = 0;
for (const file of await readdir(source, { withFileTypes: true })) {
  if (!file.isFile() || !/^[a-z0-9-]+\.(ts|json)$/.test(file.name)) continue;
  try { await copyFile(join(source, file.name), join(target, file.name), constants.COPYFILE_EXCL); added++; }
  catch (e) { if (e.code === 'EEXIST') kept++; else throw e; }
}
const artSource = fileURLToPath(new URL('../assets/art/moon-village/', import.meta.url));
const artTarget = join(root, 'apps', 'web', 'public', 'art', 'moon-village');
await mkdir(artTarget, { recursive: true });
if (!(await realpath(artTarget)).startsWith(root + sep)) throw Error('Art directory resolves outside the intended repository');
for (const file of await readdir(artSource, { withFileTypes: true })) {
  if (!file.isFile() || !/^[a-z0-9-]+\.webp$/.test(file.name)) continue;
  try { await copyFile(join(artSource, file.name), join(artTarget, file.name), constants.COPYFILE_EXCL); added++; }
  catch (e) { if (e.code === 'EEXIST') kept++; else throw e; }
}
let packageUpdated = false;
pkg.scripts ??= {}; pkg.devDependencies ??= {};
for (const [name, script] of Object.entries({ 'video:make': 'tsx scripts/video/workflow.ts', 'video:compress': 'tsx scripts/video/compress.ts', 'video:audit-audio': 'tsx scripts/video/audit-audio.ts', 'video:review-audio': 'tsx scripts/video/review-audio.ts', 'video:import-alignment': 'tsx scripts/video/import-audio-alignment.ts', 'video:repair-audio': 'tsx scripts/video/repair-audio.ts', 'video:publish-copy': 'tsx scripts/video/publish-copy.ts', 'asr:prepare': 'python scripts/asr/register.py', 'asr:start': 'node scripts/asr/service.mjs start', 'asr:status': 'node scripts/asr/service.mjs status', 'asr:restart': 'node scripts/asr/service.mjs restart', 'asr:stop': 'node scripts/asr/service.mjs stop' })) {
  if (!pkg.scripts[name]) { pkg.scripts[name] = script; packageUpdated = true; }
}
if (!pkg.devDependencies['@napi-rs/canvas'] && !pkg.dependencies?.['@napi-rs/canvas']) { pkg.devDependencies['@napi-rs/canvas'] = '0.1.100'; packageUpdated = true; }
if (packageUpdated) await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
console.log(JSON.stringify({ project: root, added, existingFilesKept: kept, packageUpdated, next: 'Install dependencies with the project package manager; then run video:make --room=latest --prepare-only.' }, null, 2));
