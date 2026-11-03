import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fullGroup } from './observability-fixture';

const dirs: string[] = [];
const hash = (input: Uint8Array) => createHash('sha256').update(input).digest('hex');
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('evaluates a complete directory group without a Python executable in PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-directory-accept-')); dirs.push(dir);
  const paths = fullGroup().map(({ manifest, observations, truth }, index) => {
    const run = join(dir, `run-${index + 1}`); mkdirSync(run);
    writeFileSync(join(run, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(run, 'observations.jsonl'), observations.map((item) => JSON.stringify(item)).join('\n') + '\n');
    writeFileSync(join(run, 'synthetic-truth.jsonl'), truth.map((item) => JSON.stringify(item)).join('\n') + '\n');
    return run;
  });
  const output = join(dir, 'out');
  const list = join(dir, 'list.json'); writeFileSync(list, JSON.stringify(paths));
  const executable = resolve('packages/session/scripts/observability-accept.ts');
  const result = spawnSync(process.execPath, ['--import', 'tsx', executable, '--partial', '--input-list', list, '--output', output],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, PATH: '' } });
  expect(result.status, result.stderr).toBe(0);
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  const manifestBytes = readFileSync(join(output, 'input-manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  expect(summary).toMatchObject({ status: 'within_thresholds', samples: 10, evaluation: { inputManifestSha256: hash(manifestBytes) } });
  expect(manifest).toMatchObject({ archive: null, selection: { sha256: hash(readFileSync(list)) }, fullArchiveVerification: null });
  for (const input of manifest.inputs) for (const key of ['manifest', 'observations', 'truth']) {
    expect(input[key].sha256).toBe(hash(readFileSync(input[key].path)));
  }
}, 45_000);
