import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { planWindow, type WindowConfig } from '../src/experiments/passive-loopback';
import { inspectLegacyFailedWindow, readBoundedJson, validateArchivedWindow } from '../src/experiments/passive-revalidation';
import { sourceRunId } from '../src/experiments/passive-source';
import { hashExpected } from '../src/experiments/passive-validator';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const jsonHash = (value: unknown) => hash(JSON.stringify(value));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'passive-revalidation-'));
  const archive = join(dir, 'preflight.gz'); const manifestPath = join(dir, 'preflight.manifest.json'); const budgetPath = join(dir, 'budget.json');
  const entries = [{ path: 'synthetic.ts', bytes: 1, sha256: hash('x') }]; const sourceHash = jsonHash(entries);
  const run = sourceRunId(sourceHash, 'preflight');
  const frames: WindowConfig['projections'] = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), i === 0 ? ['{}', '{"task":true}'] : ['{}', '{}']]));
  const inputHash = jsonHash(frames);
  const fullConfig: WindowConfig = { run, protocol: 'chat-completions', candidate: 'A', rooms: 1, providers: 1, baseMs: 80, slowMs: 400, slots: 4, sourceHash, budgetPath, budgetGroup: 'preflight', totalLimit: 150000, windowLimit: 48, projections: frames };
  const expected = planWindow(fullConfig).expected;
  const clientTrace = expected.flatMap((job, i) => [
    { ...job, side: 'client' as const, phase: 'start' as const, time: i * 5 + 1 },
    { ...job, side: 'client' as const, phase: 'end' as const, time: i * 5 + 4 },
  ]);
  const serverTruth = expected.flatMap((job, i) => [
    { ...job, side: 'server' as const, phase: 'start' as const, time: i * 5 + 2 },
    { ...job, side: 'server' as const, phase: 'end' as const, time: i * 5 + 3 },
  ]);
  const { projections: _projections, budgetPath: _budgetPath, ...config } = fullConfig;
  const env = { sourceHash, seed: 'obs-standard12-001' };
  const data = { config, inputHash, frames, env, sourceEntries: entries, expectedHash: hashExpected(expected), expected, clientTrace, serverTruth, segments: [{ name: 'normal', wallMs: 10, actionWaitMs: [1] }, { name: 'slow', wallMs: 20, actionWaitMs: [2] }], status: 'complete', errors: [] as string[], failure: null as unknown };
  const manifest = { issue: 'ARCH-PASSIVE', mode: 'preflight', run, protocol: 'chat-completions', topology: 'S01', candidate: 'A', slots: 4, seed: 'obs-standard12-001', environment: env, sourceHash, inputHash, expectedHash: data.expectedHash, status: 'complete', errors: [] as string[], failure: null as unknown, reserved: expected.length, segments: structuredClone(data.segments), logicalBytes: 0, compressedBytes: 0, sha256: '', compressedSha256: '' };
  const writeBudget = (count = expected.length, window = run) => writeFileSync(budgetPath, JSON.stringify({ version: 1, totalLimit: 150000, externalActual: 6, allocations: { S: { reserved: 360, actual: 0 }, integration: { reserved: 3000, actual: 0 } }, groups: { preflight: count, screen: 0, fault: 0, formal: 0 }, pActual: count, windows: { [window]: count }, windowGroups: { [window]: 'preflight' } }));
  const writeArchive = () => {
    const raw = Buffer.from(JSON.stringify(data)); const compressed = gzipSync(raw);
    Object.assign(manifest, { logicalBytes: raw.length, compressedBytes: compressed.length, sha256: hash(raw), compressedSha256: hash(compressed) });
    writeFileSync(archive, compressed);
  };
  const writeManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  const validate = () => validateArchivedWindow(archive, readBoundedJson(manifestPath), { runName: 'preflight', sourceHash, inputHash }, budgetPath);
  const cli = (extra: string[] = []) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/passive-revalidate.ts', '--archive', archive, '--manifest', manifestPath, '--budget', budgetPath, '--source-hash', sourceHash, '--input-hash', inputHash, ...extra], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
  const directoryCli = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/passive-revalidate.ts', '--directory', dir, '--budget', budgetPath, '--source-hash', sourceHash, '--input-hash', inputHash, '--include-index', 'true'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
  writeBudget(); writeArchive(); writeManifest();
  return { dir, archive, manifestPath, budgetPath, data, manifest, sourceHash, inputHash, writeArchive, writeManifest, writeBudget, validate, cli, directoryCli };
}

describe('read-only passive archive revalidation', () => {
  it('accepts a complete pinned archive through the same gate and CLI', async () => {
    const f = fixture();
    try {
      await expect(f.validate()).resolves.toMatchObject({ status: 'complete', reserved: 26 });
      const run = f.cli(); expect(run.error).toBeUndefined(); expect(run.status).toBe(0);
      const batch = f.directoryCli(); expect(batch.error).toBeUndefined(); expect(batch.status).toBe(0);
      expect(JSON.parse(batch.stdout)).toMatchObject({ windows: 1, reserved: 26, index: [{ name: 'preflight.gz', reserved: 26 }] });
    }
    finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it('rejects an entire missing job and four traces despite recomputed hash, reservation, proof and ledger', async () => {
    const f = fixture();
    try {
      const removed = f.data.expected.pop()!;
      f.data.clientTrace = f.data.clientTrace.filter(row => row.call !== removed.call || row.attempt !== removed.attempt);
      f.data.serverTruth = f.data.serverTruth.filter(row => row.call !== removed.call || row.attempt !== removed.attempt);
      f.data.expectedHash = hashExpected(f.data.expected); f.manifest.expectedHash = f.data.expectedHash; f.manifest.reserved--;
      f.writeBudget(f.manifest.reserved); f.writeArchive(); f.writeManifest();
      await expect(f.validate()).rejects.toThrow('expected count mismatch');
      const run = f.cli(); expect(run.error).toBeUndefined(); expect(run.status).not.toBe(0); expect(run.stderr).toContain('expected count mismatch');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it('rejects only manifest metrics changing while archive and proof remain intact', async () => {
    const f = fixture();
    try {
      f.manifest.segments[0].wallMs++; f.writeManifest();
      await expect(f.validate()).rejects.toThrow('manifest content mismatch');
      const run = f.cli(); expect(run.error).toBeUndefined(); expect(run.status).not.toBe(0); expect(run.stderr).toContain('manifest content mismatch');
      expect(f.directoryCli().status).not.toBe(0);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it('rejects a failed archive whose manifest alone claims complete with no errors', async () => {
    const f = fixture();
    try {
      f.data.status = 'failed'; f.data.errors = ['failure']; f.data.failure = { name: 'Error' }; f.writeArchive(); f.writeManifest();
      await expect(f.validate()).rejects.toThrow('manifest content mismatch');
      const run = f.cli(); expect(run.error).toBeUndefined(); expect(run.status).not.toBe(0); expect(run.stderr).toContain('manifest content mismatch');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it('inspects a legacy failed preflight without ever making it resumable or returning CLI success', async () => {
    const f = fixture();
    try {
      f.data.config.run = 'preflight';
      for (const job of f.data.expected) job.run = 'preflight';
      for (const row of f.data.clientTrace) row.run = 'preflight';
      f.data.clientTrace = f.data.clientTrace.filter(row => row.phase === 'start').slice(0, 12); f.data.serverTruth = [];
      f.data.expectedHash = hashExpected(f.data.expected); f.data.status = 'failed'; f.data.errors = ['recorded failure']; f.data.failure = undefined; f.data.segments = [];
      f.manifest.run = 'preflight'; f.manifest.expectedHash = f.data.expectedHash; f.manifest.reserved = 12; f.manifest.status = 'failed'; f.manifest.errors = [...f.data.errors]; f.manifest.failure = undefined; f.manifest.segments = [];
      f.writeBudget(12, 'preflight'); f.writeArchive(); f.writeManifest();
      const pin = { runName: 'preflight', sourceHash: f.sourceHash, inputHash: f.inputHash };
      await expect(f.validate()).rejects.toThrow('manifest identity mismatch');
      await expect(inspectLegacyFailedWindow(f.archive, readBoundedJson(f.manifestPath), pin, f.budgetPath)).resolves.toMatchObject({ status: 'failed', planned: 26, ledgerReserved: 12, clientStarts: 12, clientEnds: 0, serverStarts: 0, serverEnds: 0, result: 'recorded_failure' });
      const run = f.cli(['--legacy-failed', 'true']); expect(run.error).toBeUndefined(); expect(run.status).not.toBe(0); expect(JSON.parse(run.stdout)).toMatchObject({ planned: 26, clientStarts: 12, serverStarts: 0, result: 'recorded_failure' });
      f.manifest.status = 'complete'; f.manifest.errors = []; f.writeManifest();
      const tampered = f.cli(['--legacy-failed', 'true']); expect(tampered.status).not.toBe(0); expect(tampered.stderr).toContain('manifest content mismatch');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it('rejects an independently inconsistent ledger, altered config, and oversized proof', async () => {
    const f = fixture();
    try {
      f.writeBudget(f.manifest.reserved - 1); await expect(f.validate()).rejects.toThrow('budget ledger mismatch');
      f.writeBudget(); f.data.config.baseMs++; f.writeArchive(); f.writeManifest(); await expect(f.validate()).rejects.toThrow('archive config mismatch');
      f.manifest.logicalBytes = 128 * 1024 ** 2 + 1; f.writeManifest(); await expect(f.validate()).rejects.toThrow('invalid archive proof or size');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it('rejects changed frozen input or source entries even with a newly matching archive proof', async () => {
    const f = fixture();
    try {
      f.data.frames['1'][0] = '{"altered":true}'; f.writeArchive(); f.writeManifest();
      await expect(f.validate()).rejects.toThrow('archive input pin mismatch');
      f.data.frames['1'][0] = '{}'; f.data.sourceEntries[0].sha256 = '0'.repeat(64); f.writeArchive(); f.writeManifest();
      await expect(f.validate()).rejects.toThrow('archive source pin mismatch');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
