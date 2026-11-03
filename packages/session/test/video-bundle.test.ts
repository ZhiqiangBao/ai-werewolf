import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.cwd();
const bootstrap = resolve(root, 'skills/werewolf-video/scripts/bootstrap.mjs');
async function target() {
  const base = resolve(root, 'data/video-bootstrap-tests');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'target-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'ai-werewolf' }));
  return dir;
}
async function put(rootDir: string, file: string, content: string) {
  const destination = join(rootDir, file);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await writeFile(destination, content);
}
const invoke = (dir: string) => spawnSync(process.execPath, [bootstrap, `--project=${dir}`], { encoding: 'utf8' });

describe('video skill bundle bootstrap', () => {
  it('rejects incompatible old repositories before changing any file', async () => {
    const dir = await target();
    const result = invoke(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing packages/session/src/player-video.ts');
    expect(result.stderr).toContain('no files were installed');
    expect(await readdir(dir)).toEqual(['package.json']);
  });
  it('installs all local pipeline imports without overwriting existing files', async () => {
    const dir = await target();
    for (const [file, text] of [
      ['packages/session/src/player-video.ts', 'export function buildPlayerVideo() {}'],
      ['packages/session/scripts/export-video.ts', '// --player-seat='],
      ['packages/engine/src/index.ts', 'export const projectSeat = 1'],
      ['packages/protocol/src/index.ts', 'export const buildVideoScript = 1'],
      ['packages/session/src/secret.ts', 'export class SecretBox {}'],
      ['packages/session/src/asr.ts', 'export async function transcribeAudio() {} export async function ensureLocalAsrReady() {}'],
      ['scripts/asr/service.mjs', '// server.py'],
      ['scripts/asr/server.py', 'class PythonSocketGuard: pass'],
      ['scripts/video/voices.json', '{"custom":"preserved"}'],
    ]) await put(dir, file, text);
    const result = invoke(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'scripts/video/voices.json'), 'utf8'))).toEqual({ custom: 'preserved' });
    const directory = join(dir, 'scripts/video');
    const names = await readdir(directory);
    for (const name of ['skill-effects-core.ts', 'skill-effects.ts', 'video-effect.ts', 'player-audio-provenance.ts', 'review-audio.ts', 'asr-comparison.ts', 'import-audio-alignment.ts']) expect(names).toContain(name);
    for (const file of names.filter((name) => name.endsWith('.ts'))) {
      const content = await readFile(join(directory, file), 'utf8');
      expect(content).not.toContain("../../packages/protocol/src/skill-effects");
      for (const match of content.matchAll(/(?:from\s+|import\()\s*['"](\.\/[^'"]+)['"]/g)) {
        const local = match[1].slice(2);
        expect(names, `${file}: ${local}`).toContain(local.endsWith('.json') ? local : `${local}.ts`);
      }
    }
    const core = await readFile(join(directory, 'skill-effects-core.ts'), 'utf8');
    expect(core).toContain("case 'mirror.result'");
    expect(core).toContain("case 'awakened.knife'");
    expect(() => execFileSync(process.execPath, [bootstrap, `--project=${dir}`], { stdio: 'pipe' })).not.toThrow();
    expect(JSON.parse(await readFile(join(dir, 'scripts/video/voices.json'), 'utf8'))).toEqual({ custom: 'preserved' });
  });
});
