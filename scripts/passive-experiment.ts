import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { archiveEvidence, verifyEvidenceArchive, type ArchiveProof, type StorageUsage } from '../packages/session/src/experiments/passive-archive';
import { runLoopbackWindow, type Candidate, type Protocol } from '../packages/session/src/experiments/passive-loopback';
import { fixedProjections } from '../packages/session/src/experiments/passive-projections';
import { sourceRunId, sourceSnapshot } from '../packages/session/src/experiments/passive-source';
import { compareScreen } from '../packages/session/src/experiments/passive-screen';

const protocols: Protocol[] = ['chat-completions', 'responses', 'anthropic-messages'];
const topologies = ['S01', 'S02', 'S03'] as const; const candidates: Candidate[] = ['A', 'B', 'A+D'];
const seed = 'obs-standard12-001';
const windows = protocols.flatMap(protocol => topologies.flatMap(topology => candidates.map(candidate => ({ protocol, topology, candidate }))));
const args = process.argv.slice(2);
if (args.join(' ') === '--dry-run') {
  console.log(JSON.stringify({ status: 'planned_not_run', seed, windows, candidateWindows: 27, candidateHttpLimit: 13824, preflightHttpLimit: 48, faultHttpLimit: 4000, allBatchHttpLimit: 150000, realModelCalls: 0, limitations: ['D 4/8 slot selection required', 'synthetic native payloads, not provider adapters', 'exclusive time and behaviour gates required'] }, null, 2));
} else if (args.length === 3 && args[0] === '--execute' && args[2] === '--exclusive-authorized' && ['preflight', 'd4', 'd8', 'fault503', 'screen'].includes(args[1])) {
  const mode = args[1]; const root = process.cwd(); const batch = join(root, 'data', 'diagnostics', 'p1-20261103'); const directory = join(batch, 'passive'); const budget = join(batch, 'budget.json');
  if (!existsSync(budget)) throw new Error('shared budget is absent; never reset on resume');
  for (const path of [join(root, 'data'), join(root, 'data', 'diagnostics'), batch, directory]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('diagnostics symlink');
  mkdirSync(directory, { recursive: true });
  for (const path of [join(root, 'data'), join(root, 'data', 'diagnostics'), batch, directory]) if (lstatSync(path).isSymbolicLink()) throw new Error('diagnostics symlink');
  const disk = statfsSync(directory); if (Number(disk.bavail) * Number(disk.bsize) < 5 * 1024 ** 3) throw new Error('less than 5 GiB available');
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'packages/protocol/src', 'packages/protocol/package.json', 'packages/engine/src', 'packages/engine/package.json', 'packages/engine/test/harness.ts', 'packages/llm/src', 'packages/llm/package.json', 'packages/session/src', 'packages/session/package.json', 'packages/session/test', 'scripts/passive-experiment.ts', 'package.json', 'tsconfig.json', 'pnpm-lock.yaml', 'docs/P1剩余四项一揽子实施方案.md'], { encoding: 'utf8' });
  if (dirty.trim()) throw new Error('source or validator files are not committed');
  const initial = sourceSnapshot(root); const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const clockPath = join(batch, 'batch-clock.json');
  if (!existsSync(clockPath) || lstatSync(clockPath).isSymbolicLink()) throw new Error('original cross-version batch clock is required');
  const clock = JSON.parse(readFileSync(clockPath, 'utf8')) as { startedAt: number };
  if (!Number.isSafeInteger(clock.startedAt) || Date.now() < clock.startedAt || Date.now() - clock.startedAt >= 180 * 60 * 1000) throw new Error('invalid or expired batch clock');
  const metaPath = join(directory, 'batch-meta.json');
  if (!existsSync(metaPath)) { if (mode !== 'preflight') throw new Error('preflight must initialize batch metadata'); writeFileSync(metaPath, JSON.stringify({ sourceHash: initial.sha256, startedAt: clock.startedAt }), { flag: 'wx' }); }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { sourceHash: string; startedAt: number };
  if (meta.sourceHash !== initial.sha256 || meta.startedAt !== clock.startedAt) throw new Error('source mismatch or batch wall-clock limit');
  const env = { node: process.version, pnpmVersion: null, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), loadAverage: platform() === 'win32' ? null : loadavg(), powerCondition: null, sourceCommit, sourceHash: initial.sha256, command: process.argv.slice(1), seed };
  const files = readdirSync(directory); if (files.some(name => lstatSync(join(directory, name)).isSymbolicLink())) throw new Error('diagnostics symlink');
  if (files.some(name => name.endsWith('.gz') && !files.includes(name.replace(/\.gz$/, '.manifest.json')))) throw new Error('unindexed archive; inspect previous incomplete run');
  const manifests = files.filter(name => name.endsWith('.manifest.json')).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as { sourceHash: string; logicalBytes: number; compressedBytes: number });
  if (manifests.some(m => m.sourceHash !== initial.sha256 || !Number.isSafeInteger(m.logicalBytes) || !Number.isSafeInteger(m.compressedBytes))) throw new Error('source changed or invalid manifest; do not mix runs');
  const usage: StorageUsage = { logical: manifests.reduce((n, m) => n + m.logicalBytes, 0), compressed: manifests.reduce((n, m) => n + m.compressedBytes, 0), compact: files.filter(name => name.endsWith('.json')).reduce((n, name) => n + lstatSync(join(directory, name)).size, 0), peak: files.reduce((n, name) => n + lstatSync(join(directory, name)).size, 0) };
  const frames = fixedProjections(seed); const inputHash = createHash('sha256').update(JSON.stringify(frames)).digest('hex');
  const runOne = async (run: string, protocol: Protocol, topology: typeof topologies[number], candidate: Candidate, slots: 4 | 8, fault: boolean) => {
    const runId = sourceRunId(initial.sha256, run);
    if (sourceSnapshot(root).sha256 !== initial.sha256) throw new Error('source changed during batch');
    if (Date.now() < meta.startedAt || Date.now() - meta.startedAt >= 180 * 60 * 1000) throw new Error('batch wall-clock limit');
    const remainingMs = meta.startedAt + 180 * 60 * 1000 - Date.now();
    if (remainingMs <= 4000) throw new Error('insufficient time for bounded cleanup');
    const free = statfsSync(directory); if (Number(free.bavail) * Number(free.bsize) < 5 * 1024 ** 3) throw new Error('less than 5 GiB available');
    if (usage.logical >= 4 * 1024 ** 3 * .7 || usage.compressed >= 768 * 1024 ** 2 * .7 || usage.compact >= 128 * 1024 ** 2 * .7 || usage.peak >= 1.25 * 1024 ** 3 * .7) console.warn('P batch storage has reached a 70% warning threshold');
    const output = join(directory, `${run}.gz`); const manifestPath = join(directory, `${run}.manifest.json`);
    if (existsSync(output) || existsSync(manifestPath)) {
      if (!existsSync(output) || !existsSync(manifestPath) || lstatSync(output).isSymbolicLink() || lstatSync(manifestPath).isSymbolicLink()) throw new Error(`incomplete or unsafe prior run: ${run}`);
      const prior = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveProof & { run: string; protocol: Protocol; topology: string; candidate: Candidate; slots: number; sourceHash: string; inputHash: string; status: string; errors: string[]; segments: Array<{ name: string; wallMs: number; actionWaitMs: number[] }> };
      if (prior.run !== runId || prior.protocol !== protocol || prior.topology !== topology || prior.candidate !== candidate || prior.slots !== slots || prior.sourceHash !== initial.sha256 || prior.inputHash !== inputHash || prior.status !== 'complete' || !Array.isArray(prior.errors) || prior.errors.length) throw new Error(`incompatible prior run: ${run}`);
      await verifyEvidenceArchive(output, prior, AbortSignal.timeout(remainingMs - 200)); return prior;
    }
    const config = { run: runId, protocol, candidate, rooms: (topology === 'S01' ? 1 : 2) as 1 | 2, providers: (topology === 'S03' ? 2 : 1) as 1 | 2, baseMs: 80, slowMs: 400, slots, ...(fault ? { serverSlots: 4 as const, faultStatus: (mode === 'fault503' ? 503 : 429) as 429 | 503 } : {}), sourceHash: initial.sha256, budgetPath: budget, budgetGroup: (mode === 'preflight' ? 'preflight' : fault ? 'fault' : 'screen') as 'preflight' | 'fault' | 'screen', totalLimit: 150000, windowLimit: mode === 'preflight' ? 48 : 512, projections: frames, signal: AbortSignal.timeout(remainingMs - 3000) };
    const result = await runLoopbackWindow(config);
    if (sourceSnapshot(root).sha256 !== initial.sha256) { result.evidence.status = 'failed'; result.errors.push('source changed during window'); }
    const archiveRemainingMs = meta.startedAt + 180 * 60 * 1000 - Date.now() - 200;
    if (archiveRemainingMs <= 0) throw new Error('no time to archive incomplete window');
    const archive = await archiveEvidence(output, { config: { ...config, projections: undefined, budgetPath: undefined, signal: undefined }, inputHash, frames, env, sourceEntries: initial.entries, expectedHash: result.evidence.expectedHash, expected: result.evidence.expected, clientTrace: result.clientTrace, serverTruth: result.serverTruth, segments: result.segments, status: result.evidence.status, errors: result.errors, failure: result.failure }, usage, AbortSignal.timeout(archiveRemainingMs));
    const compact = { issue: 'ARCH-PASSIVE', mode, run: runId, protocol, topology, candidate, slots, seed, environment: env, sourceHash: initial.sha256, inputHash, expectedHash: result.evidence.expectedHash, status: result.evidence.status, errors: result.errors, failure: result.failure, reserved: result.evidence.reserved, segments: result.segments, ...archive };
    const encoded = JSON.stringify(compact); if (usage.compact + Buffer.byteLength(encoded) >= 128 * 1024 ** 2 * .9 || usage.peak + Buffer.byteLength(encoded) >= 1.25 * 1024 ** 3 * .9) throw new Error('compact stop threshold');
    writeFileSync(manifestPath, encoded, { flag: 'wx' }); usage.compact += Buffer.byteLength(encoded); usage.peak += Buffer.byteLength(encoded);
    if (result.errors.length || result.evidence.status !== 'complete') throw new Error(`incomplete window: ${run}`);
    return compact;
  };
  if (mode === 'preflight') await runOne('preflight', 'chat-completions', 'S01', 'A', 4, false);
  else if (mode === 'd4' || mode === 'd8' || mode === 'fault503') {
    if (!existsSync(join(directory, 'preflight.manifest.json'))) throw new Error('preflight required first');
    await runOne('preflight', 'chat-completions', 'S01', 'A', 4, false);
    const slots = mode === 'd8' ? 8 : 4;
    await runOne(`${mode}-A`, 'responses', 'S02', 'A', slots, true);
    if (mode !== 'fault503') await runOne(`${mode}-D`, 'responses', 'S02', 'A+D', slots, true);
  } else {
    for (const name of ['preflight', 'd4-A', 'd4-D', 'd8-A', 'd8-D']) if (!existsSync(join(directory, `${name}.manifest.json`))) throw new Error(`required prior window missing: ${name}`);
    const required = [await runOne('preflight', 'chat-completions', 'S01', 'A', 4, false), await runOne('d4-A', 'responses', 'S02', 'A', 4, true), await runOne('d4-D', 'responses', 'S02', 'A+D', 4, true), await runOne('d8-A', 'responses', 'S02', 'A', 8, true), await runOne('d8-D', 'responses', 'S02', 'A+D', 8, true)];
    if (required.some(m => m.status !== 'complete' || m.errors.length || m.sourceHash !== initial.sha256)) throw new Error('preflight/fault selection incomplete');
    const d4 = required[2].segments.reduce((n, s) => n + s.wallMs, 0); const d8 = required[4].segments.reduce((n, s) => n + s.wallMs, 0);
    const slots = d4 <= d8 ? 4 : 8; // Provisional screening choice, not a claim of controlled benefit.
    const completed = [];
    for (const w of windows) completed.push(await runOne(`screen-${w.protocol}-${w.topology}-${w.candidate === 'A+D' ? 'AD' : w.candidate}`, w.protocol, w.topology, w.candidate, slots, false));
    const comparisons = protocols.flatMap(protocol => topologies.map(topology => {
      const baseline = completed.find(m => m.protocol === protocol && m.topology === topology && m.candidate === 'A')!;
      const candidate = completed.find(m => m.protocol === protocol && m.topology === topology && m.candidate === 'B')!;
      return { protocol, topology, samplesPerCandidate: 1, ...compareScreen(baseline.segments, candidate.segments) };
    }));
    const report = { issue: 'ARCH-PASSIVE', sourceHash: initial.sha256, inputHash, seed, comparisons, decision: 'screen_only_no_formal_run', limitations: ['one window per cell is not a formal median or uncertainty estimate', 'noise, heap and token gates not yet established', 'fixed synthetic projections and native stubs do not measure complete games or real providers', 'D choice is provisional'] };
    const reportPath = join(directory, 'screen-summary.json'); const data = JSON.stringify(report);
    if (!existsSync(reportPath)) { if (usage.compact + Buffer.byteLength(data) >= 128 * 1024 ** 2 * .9 || usage.peak + Buffer.byteLength(data) >= 1.25 * 1024 ** 3 * .9) throw new Error('summary stop threshold'); writeFileSync(reportPath, data, { flag: 'wx' }); }
    console.log(data);
  }
} else {
  console.error('Use --dry-run, or --execute preflight|d4|d8|fault503|screen --exclusive-authorized only after the owner confirms the exclusive period and behaviour gates.'); process.exitCode = 1;
}
