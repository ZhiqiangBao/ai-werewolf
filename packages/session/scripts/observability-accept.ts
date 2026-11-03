import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBaselineAcceptance, type BaselineEvidence } from '../src/observability/acceptance';
import { ObservationArchive } from '../src/observability/archive-reader';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const parse = (bytes: Buffer): unknown => {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid JSON or UTF-8 in acceptance input'); }
};
const jsonl = (bytes: Buffer): unknown[] => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)); }
  catch { throw new Error('Invalid JSONL or UTF-8 in acceptance input'); }
};

async function main() {
  const argv = process.argv.slice(2), directories: string[] = [], flags = new Map<string, string>();
  const valueFlags = new Set(['--output', '--archive', '--archive-index', '--expected-archive-sha256', '--python',
    '--input-list', '--expected-source-sha256', '--expected-source-revision']);
  let partial = false, verifyAll = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--partial') { partial = true; continue; }
    if (arg === '--verify-all-archive-members') { verifyAll = true; continue; }
    if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--') || flags.has(arg)) throw new Error('Missing or repeated acceptance option');
      flags.set(arg, value); continue;
    }
    if (arg.startsWith('--')) throw new Error('Unknown acceptance option');
    directories.push(arg);
  }
  const output = resolve(flags.get('--output') ?? 'data/diagnostics/accuracy-acceptance');
  const startedAt = new Date().toISOString();
  let revision = 'unknown', dirty: boolean | null = null;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    dirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  } catch { /* Hashes below still identify the exact checker sources. */ }
  const checkerFiles = ['observability-accept.ts', '../src/observability/acceptance.ts', '../src/observability/archive-reader.ts'];
  const checker = [];
  for (const file of checkerFiles) {
    const bytes = await readFile(fileURLToPath(new URL(file, import.meta.url)));
    checker.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  let selection: { path: string; sha256: string; selector: string } | null = null;
  const list = flags.get('--input-list');
  if (list) {
    const bytes = await readFile(resolve(list)), input = parse(bytes);
    let selected: unknown;
    if (Array.isArray(input)) selected = input;
    else if (input && typeof input === 'object' && Array.isArray((input as { directories?: unknown }).directories))
      selected = (input as { directories: unknown[] }).directories;
    else if (input && typeof input === 'object' && Array.isArray((input as { results?: unknown }).results)) {
      const commands = (input as { results: { kind?: unknown; exitCode?: unknown; directories?: unknown }[] }).results.filter((row) => row?.kind === 'formal');
      if (!commands.length || commands.some((row) => row.exitCode !== 0 || !Array.isArray(row.directories) || !row.directories.length))
        throw new Error('Formal command input list is incomplete');
      selected = commands.flatMap((row) => row.directories as unknown[]);
    } else throw new Error('Input list must contain run directories or completed formal commands');
    if (!Array.isArray(selected) || !selected.length || selected.some((dir) => typeof dir !== 'string' || !dir))
      throw new Error('Invalid run directory list');
    directories.push(...selected as string[]);
    selection = { path: resolve(list), sha256: hash(bytes), selector: Array.isArray(input) ? 'directory_array' : 'directories_or_formal_commands' };
  }
  if (!directories.length) throw new Error('请传入合成运行目录或 --input-list；默认要求完整正常矩阵');
  const archivePath = flags.get('--archive');
  if (!archivePath && (flags.has('--archive-index') || flags.has('--expected-archive-sha256') || flags.has('--python') || verifyAll))
    throw new Error('Archive options require --archive');
  let archive: ObservationArchive | undefined;
  if (archivePath) {
    if (!flags.get('--archive-index') || !flags.get('--expected-archive-sha256')) throw new Error('Archive mode requires its index and pinned SHA-256');
    archive = await ObservationArchive.open({ archive: archivePath, index: flags.get('--archive-index')!,
      expectedSha256: flags.get('--expected-archive-sha256')!, ...(flags.get('--python') ? { python: flags.get('--python')! } : {}) });
  }
  const expected = { ...(flags.has('--expected-source-sha256') ? { expectedSourceSha256: flags.get('--expected-source-sha256')! } : {}),
    ...(flags.has('--expected-source-revision') ? { expectedSourceRevision: flags.get('--expected-source-revision')! } : {}) };
  const acceptance = createBaselineAcceptance(!partial, expected);
  const inputs = [];
  for (const directory of directories) {
    const dir = resolve(directory), manifestPath = resolve(dir, 'manifest.json'), manifestBytes = await readFile(manifestPath);
    const read = async (file: string) => {
      if (archive) {
        const name = basename(dir);
        if (!/^run-[A-Za-z0-9]+$/.test(name)) throw new Error('Normal archive inputs must name synthetic run directories');
        const member = 'synthetic/' + name + '/' + file;
        const result = await archive.read(member);
        return { bytes: result.bytes, provenance: { kind: 'archive_member', ...result.provenance } };
      }
      const path = resolve(dir, file), bytes = await readFile(path);
      return { bytes, provenance: { kind: 'file', path, bytes: bytes.length, sha256: hash(bytes) } };
    };
    const observations = await read('observations.jsonl'), truth = await read('synthetic-truth.jsonl');
    acceptance.add({ manifest: parse(manifestBytes), observations: jsonl(observations.bytes), truth: jsonl(truth.bytes) } as BaselineEvidence);
    inputs.push({ directory: dir, manifest: { path: manifestPath, bytes: manifestBytes.length, sha256: hash(manifestBytes) },
      observations: observations.provenance, truth: truth.provenance });
  }
  const result = acceptance.finish();
  const fullArchiveVerification = verifyAll ? await archive!.verifyAll() : null;
  if (archive && !verifyAll) await archive.assertUnchanged();
  for (const input of inputs) if (hash(await readFile(input.manifest.path)) !== input.manifest.sha256)
    throw new Error('Manifest changed during acceptance');
  if (selection && hash(await readFile(selection.path)) !== selection.sha256) throw new Error('Input selection changed during acceptance');
  for (const file of checker) if (hash(await readFile(fileURLToPath(new URL(file.file, import.meta.url)))) !== file.sha256)
    throw new Error('Acceptance checker changed during evaluation');
  const provenance = { schemaVersion: 1, checkerRevision: revision, checkerDirty: dirty, checkerFiles: checker,
    startedAt, completedAt: new Date().toISOString(), node: process.version, command: [process.execPath, ...process.argv.slice(1)],
    requireFullMatrix: !partial, expectedSource: expected, selection, archive: archive?.provenance ?? null,
    fullArchiveVerification, inputs };
  const inputManifest = JSON.stringify(provenance, null, 2) + '\n';
  const summary = { ...result, evaluation: { checkerRevision: revision, checkerFiles: checker,
    inputManifest: 'input-manifest.json', inputManifestSha256: hash(Buffer.from(inputManifest)) } };
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'input-manifest.json'), inputManifest);
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(resolve(output, 'report.md'), '# 本机合成计时准确度与双向完整性\n\n状态：' + result.status + '。保留全部样本，未删除异常值。\n\n' +
    '验收器版本：' + revision + '；输入、原始成员哈希、源码 pin 和命令见 input-manifest.json。HTTP／真值列仅为正式样本；完整性计数包含预热。\n\n' +
    '| 场景／协议 | 正式／预热 | 正式 HTTP／匹配 | truth 原始／唯一 | HTTP 开始／结束 | 双向缺失／重复／跨运行 | 状态 |\n' +
    '| --- | --- | --- | --- | --- | --- | --- |\n' + result.results.map((row) => {
      const i = row.integrity, missing = i.truthWithoutStart.length + i.truthWithoutEnd.length + i.httpStartsWithoutTruth.length + i.httpEndsWithoutTruth.length;
      return '| ' + row.key + ' | ' + row.formalRuns + '／' + row.warmups + ' | ' + row.attempts + '／' + row.matchedTruth +
        ' | ' + i.truthRaw + '／' + i.truthUnique + ' | ' + i.httpStartsRaw + '／' + i.httpEndsRaw + ' | ' +
        missing + '／' + (i.duplicateTruth + i.duplicateHttpStarts + i.duplicateHttpEnds) + '／' + (i.crossRunTruth + i.crossRunObservations) + ' | ' + row.status + ' |';
    }).join('\n') + '\n\n本命令只验收正常 S01／S02／S03；故障分支及未开启观测的配对对照不以缺真值豁免纳入通过。\n');
  console.log('Accuracy output: ' + output + ' (' + result.status + ')');
  if (result.status !== 'within_thresholds') process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Accuracy evaluation failed'); process.exitCode = 1; });
