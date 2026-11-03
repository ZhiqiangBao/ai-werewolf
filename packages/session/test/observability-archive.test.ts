import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObservationArchive } from '../src/observability/archive-reader';
import { fullGroup, revision, source } from './observability-fixture';

const python = process.env.OBSERVABILITY_TEST_PYTHON ?? 'python';
const pythonAvailable = spawnSync(python, ['-c', 'import zipfile'], { windowsHide: true, encoding: 'utf8' }).status === 0;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type File = { path: string; bytes: Buffer };
type Descriptor = { path: string; bytes: number; sha256: string };
const indexFor = (files: Descriptor[]) => ({ files, fileCount: files.length, uncompressedBytes: files.reduce((sum, file) => sum + file.bytes, 0) });
const zipScript = [
  'import base64,json,sys,warnings,zipfile',
  'warnings.simplefilter("ignore", UserWarning)',
  'payload=json.load(sys.stdin)',
  'with zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED) as z:',
  ' for item in payload["members"]:',
  '  with z.open(item["path"],"w",force_zip64=True) as f: f.write(base64.b64decode(item["data"]))',
  ' with z.open("_obs-archive-index.json","w",force_zip64=True) as f: f.write(base64.b64decode(payload["embedded"]))',
].join('\n');

function fixture(files: File[], options: { declared?: Descriptor[]; embedded?: Descriptor[]; duplicate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-archive-test-')); dirs.push(dir);
  const archive = join(dir, 'observations.zip'), index = join(dir, 'index.json');
  const descriptors = options.declared ?? files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha(file.bytes) }));
  const embedded = Buffer.from(JSON.stringify(indexFor(options.embedded ?? descriptors)));
  const contents = options.duplicate ? [...files, files[0]] : files;
  const payload = { members: contents.map((file) => ({ path: file.path, data: file.bytes.toString('base64') })), embedded: embedded.toString('base64') };
  const result = spawnSync(python, ['-c', zipScript, archive], { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Unable to create test ZIP: ${result.stderr}`);
  const archiveBytes = readFileSync(archive), archiveSha256 = sha(archiveBytes);
  const external = Buffer.from(JSON.stringify({ ...indexFor(descriptors), archiveSha256, archiveBytes: archiveBytes.length }));
  writeFileSync(index, external);
  return { dir, archive, index, archiveSha256, external, embedded, descriptors };
}
const files = (): File[] => [
  { path: 'synthetic/run-abc/observations.jsonl', bytes: Buffer.from('{"kind":"synthetic"}\n') },
  { path: 'synthetic/run-abc/synthetic-truth.jsonl', bytes: Buffer.from('{"source":"synthetic"}\n') },
];
const open = (f: ReturnType<typeof fixture>, expectedSha256 = f.archiveSha256) => ObservationArchive.open({ archive: f.archive, index: f.index, expectedSha256, python });

describe.skipIf(!pythonAvailable)('optional compressed archive reader', () => {
  it('reads selected ZIP64 members, verifies all members, and never expands files', async () => {
    const source = files(), f = fixture(source), before = readdirSync(f.dir).sort();
    const archive = await open(f);
    const result = await archive.read(source[0].path);
    expect(result.bytes).toEqual(source[0].bytes);
    expect(result.provenance).toEqual(f.descriptors[0]);
    expect(archive.provenance).toMatchObject({ archiveSha256: f.archiveSha256, archiveBytes: statSync(f.archive).size,
      indexSha256: sha(f.external), embeddedIndexSha256: sha(f.embedded), memberCount: 2 });
    expect(await archive.verifyAll()).toEqual({ verifiedMembers: 2, verifiedBytes: source.reduce((sum, file) => sum + file.bytes.length, 0) });
    expect(readdirSync(f.dir).sort()).toEqual(before);
  });

  it('rejects a wrong archive pin before accepting the contents', async () => {
    const f = fixture(files());
    await expect(open(f, '0'.repeat(64))).rejects.toThrow(/SHA-256/);
  });

  it('rejects disagreeing sidecar and embedded indexes', async () => {
    const source = files();
    const embedded = source.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha(file.bytes) }));
    embedded[0].sha256 = '0'.repeat(64);
    await expect(open(fixture(source, { embedded }))).rejects.toThrow(/indexes disagree/);
  });

  it('detects a member hash mismatch both on selection and full verification', async () => {
    const source = files();
    const declared = source.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha(file.bytes) }));
    declared[1].sha256 = '0'.repeat(64);
    const archive = await open(fixture(source, { declared }));
    await expect(archive.read(source[1].path)).rejects.toThrow(/SHA-256/);
    await expect(archive.verifyAll()).rejects.toThrow();
  });

  it('rejects duplicated archive members and catalog entries missing from the ZIP', async () => {
    const source = files();
    await expect(open(fixture(source, { duplicate: true }))).rejects.toThrow(/missing, extra, or duplicate/);
    const declared = [...source.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha(file.bytes) })),
      { path: 'synthetic/run-other/missing.jsonl', bytes: 1, sha256: sha(Buffer.from('x')) }];
    await expect(open(fixture(source, { declared }))).rejects.toThrow(/missing, extra, or duplicate/);
  });

  it('accepts uppercase hexadecimal member hashes consistently during full verification', async () => {
    const source = files();
    const declared = source.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: sha(file.bytes).toUpperCase() }));
    const archive = await open(fixture(source, { declared }));
    expect((await archive.read(source[0].path)).bytes).toEqual(source[0].bytes);
    await expect(archive.verifyAll()).resolves.toMatchObject({ verifiedMembers: 2 });
  });
});

describe.skipIf(!pythonAvailable)('offline acceptance command with archived evidence', () => {
  it('accepts one complete group and preserves verifiable provenance; invalid evidence exits nonzero with a report', () => {
    const evidence = fullGroup().map((item, index) => ({ name: `run-${index + 1}`, ...item }));
    const jsonl = (items: unknown[]) => Buffer.from(items.map((item) => JSON.stringify(item)).join('\n') + '\n');
    const members = evidence.flatMap((item): File[] => [
      { path: `synthetic/${item.name}/observations.jsonl`, bytes: jsonl(item.observations) },
      { path: `synthetic/${item.name}/synthetic-truth.jsonl`, bytes: jsonl(item.truth) },
    ]);
    const f = fixture(members);
    const paths = evidence.map((item) => {
      const dir = join(f.dir, item.name); mkdirSync(dir);
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(item.manifest));
      return dir;
    });
    const inputList = join(f.dir, 'selection.json'); writeFileSync(inputList, JSON.stringify(paths));
    const script = resolve('packages/session/scripts/observability-accept.ts');
    const invoke = (output: string) => spawnSync(process.execPath, ['--import', 'tsx', script, '--partial', '--input-list', inputList,
      '--archive', f.archive, '--archive-index', f.index, '--expected-archive-sha256', f.archiveSha256,
      '--python', python, '--verify-all-archive-members', '--expected-source-sha256', source, '--expected-source-revision', revision,
      '--output', output], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const output = join(f.dir, 'accepted');
    const accepted = invoke(output);
    expect(accepted.status, accepted.stderr).toBe(0);
    const summaryBytes = readFileSync(join(output, 'summary.json'));
    const summary = JSON.parse(summaryBytes.toString('utf8'));
    expect(summary).toMatchObject({ status: 'within_thresholds', samples: 10, results: [{ key: 'S01/responses', formalRuns: 9, warmups: 1, status: 'within_thresholds' }] });
    const manifestBytes = readFileSync(join(output, 'input-manifest.json'));
    const provenance = JSON.parse(manifestBytes.toString('utf8'));
    expect(summary.evaluation.inputManifestSha256).toBe(sha(manifestBytes));
    expect(provenance).toMatchObject({ requireFullMatrix: false, selection: { path: inputList, sha256: sha(readFileSync(inputList)) },
      archive: { archiveSha256: f.archiveSha256, indexSha256: sha(f.external), embeddedIndexSha256: sha(f.embedded), memberCount: 20 },
      fullArchiveVerification: { verifiedMembers: 20 }, expectedSource: { expectedSourceSha256: source, expectedSourceRevision: revision } });
    expect(provenance.inputs).toHaveLength(10);
    for (const input of provenance.inputs) {
      expect(input.manifest.sha256).toBe(sha(readFileSync(input.manifest.path)));
      for (const key of ['observations', 'truth']) {
        const member = members.find((item) => item.path === input[key].path)!;
        expect(input[key]).toMatchObject({ kind: 'archive_member', bytes: member.bytes.length, sha256: sha(member.bytes) });
      }
    }
    expect(paths.every((dir) => readdirSync(dir).join(',') === 'manifest.json')).toBe(true);

    // Relabel the complete group, so rejection depends on protocol evidence,
    // not merely on a now-incomplete matrix cell.
    for (const path of paths) {
      const badManifest = join(path, 'manifest.json');
      const changed = JSON.parse(readFileSync(badManifest, 'utf8')); changed.protocol = 'anthropic_messages';
      writeFileSync(badManifest, JSON.stringify(changed));
    }
    const failedOutput = join(f.dir, 'rejected'), rejected = invoke(failedOutput);
    expect(rejected.status, rejected.stderr).toBe(1);
    const rejectedSummary = JSON.parse(readFileSync(join(failedOutput, 'summary.json'), 'utf8'));
    const rejectedProvenance = JSON.parse(readFileSync(join(failedOutput, 'input-manifest.json'), 'utf8'));
    expect(rejectedSummary).toMatchObject({ status: 'not_passed', results: [{ key: 'S01/anthropic_messages', status: 'invalid' }] });
    expect(readFileSync(join(failedOutput, 'report.md'), 'utf8')).toContain('not_passed');
    for (const input of rejectedProvenance.inputs) expect(input.manifest.sha256).toBe(sha(readFileSync(input.manifest.path)));
  }, 120_000);
});
