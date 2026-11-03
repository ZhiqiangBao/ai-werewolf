import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { readVerifiedEvidenceArchive, type ArchiveProof } from './passive-archive';
import { readBudgetWindow } from './passive-budget';
import { reconstructPlan, type FrozenConfig, type FrozenFrames } from './passive-plan';
import { sourceRunId } from './passive-source';
import { validateEvidence, type Evidence, type Expected, type Trace } from './passive-validator';

type Segment = { name: string; wallMs: number; actionWaitMs: number[] };
export type PassiveManifest = ArchiveProof & {
  issue: string; mode: string; run: string; protocol: FrozenConfig['protocol']; topology: string; candidate: FrozenConfig['candidate']; slots: number;
  seed: string; environment: Record<string, unknown>; sourceHash: string; inputHash: string; expectedHash: string;
  status: Evidence['status']; errors: string[]; failure: unknown; reserved: number; segments: Segment[];
};
type Archived = {
  config: FrozenConfig; inputHash: string; frames: FrozenFrames; env: Record<string, unknown>;
  sourceEntries: Array<{ path: string; sha256: string; bytes: number }>; expectedHash: string; expected: Expected[];
  clientTrace: Trace[]; serverTruth: Trace[]; segments: Segment[]; status: Evidence['status']; errors: string[]; failure: unknown;
};
export type WindowPin = { runName: string; sourceHash: string; inputHash: string; slots?: 4 | 8 };
const seed = 'obs-standard12-001';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const requireCondition = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };

/** Establish window identity from its file/run name, not from its manifest. */
function scenario(runName: string): { mode: string; protocol: FrozenConfig['protocol']; topology: string; candidate: FrozenConfig['candidate']; slots?: 4 | 8; faultStatus?: 429 | 503 } {
  if (runName === 'preflight') return { mode: 'preflight', protocol: 'chat-completions', topology: 'S01', candidate: 'A', slots: 4 };
  const fault = /^(d4|d8|fault503)-(A|D)$/.exec(runName);
  if (fault && !(fault[1] === 'fault503' && fault[2] === 'D')) return { mode: fault[1], protocol: 'responses', topology: 'S02', candidate: fault[2] === 'D' ? 'A+D' : 'A', slots: fault[1] === 'd8' ? 8 : 4, faultStatus: fault[1] === 'fault503' ? 503 : 429 };
  const screen = /^screen-(chat-completions|responses|anthropic-messages)-(S01|S02|S03)-(A|B|AD)$/.exec(runName);
  if (!screen) throw new Error('invalid window name');
  return { mode: 'screen', protocol: screen[1] as FrozenConfig['protocol'], topology: screen[2], candidate: screen[3] === 'AD' ? 'A+D' : screen[3] as FrozenConfig['candidate'] };
}

export function readBoundedJsonWithHash(path: string, maxBytes = 1024 * 1024): { value: unknown; sha256: string } {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) throw new Error('unsafe JSON file or size');
  const bytes = readFileSync(path);
  if (bytes.length !== info.size || bytes.length > maxBytes) throw new Error('JSON file changed or size exceeded');
  return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function readBoundedJson(path: string, maxBytes = 1024 * 1024): unknown { return readBoundedJsonWithHash(path, maxBytes).value; }

/** Verify proof before a bounded read, then cross-check all summary and semantic inputs. */
async function inspectWindow(path: string, value: unknown, pin: WindowPin, budgetPath: string, legacyFailed: boolean, signal?: AbortSignal) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'invalid manifest');
  const manifest = value as PassiveManifest;
  requireCondition(hash(pin.sourceHash) && hash(pin.inputHash), 'invalid independent pin');
  requireCondition(!legacyFailed || pin.runName === 'preflight', 'unsupported legacy run');
  const window = scenario(pin.runName); const run = legacyFailed ? pin.runName : sourceRunId(pin.sourceHash, pin.runName);
  requireCondition(manifest.issue === 'ARCH-PASSIVE' && manifest.mode === window.mode && manifest.run === run && manifest.protocol === window.protocol && manifest.topology === window.topology && manifest.candidate === window.candidate && [4, 8].includes(manifest.slots) && (window.slots === undefined || manifest.slots === window.slots) && (pin.slots === undefined || manifest.slots === pin.slots) && manifest.seed === seed && manifest.sourceHash === pin.sourceHash && manifest.inputHash === pin.inputHash, 'manifest identity mismatch');
  const data = await readVerifiedEvidenceArchive(path, manifest, signal) as Archived;
  requireCondition(data && typeof data === 'object' && !Array.isArray(data), 'invalid archive');
  const config = data.config;
  requireCondition(config && typeof config === 'object' && config.run === run && config.sourceHash === pin.sourceHash && config.protocol === window.protocol && config.candidate === window.candidate && config.slots === manifest.slots && config.rooms === (window.topology === 'S01' ? 1 : 2) && config.providers === (window.topology === 'S03' ? 2 : 1) && config.baseMs === 80 && config.slowMs === 400 && config.totalLimit === 150000 && config.windowLimit === (window.mode === 'preflight' ? 48 : 512) && config.budgetGroup === (window.mode === 'preflight' ? 'preflight' : window.mode === 'screen' ? 'screen' : 'fault') && config.faultStatus === window.faultStatus && config.serverSlots === (window.faultStatus === undefined ? undefined : 4), 'archive config mismatch');
  requireCondition(data.inputHash === pin.inputHash && digest(data.frames) === pin.inputHash, 'archive input pin mismatch');
  requireCondition(Array.isArray(data.sourceEntries) && data.sourceEntries.length > 0 && data.sourceEntries.every(entry => entry && typeof entry.path === 'string' && entry.path.length > 0 && hash(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0) && new Set(data.sourceEntries.map(entry => entry.path)).size === data.sourceEntries.length && digest(data.sourceEntries) === pin.sourceHash, 'archive source pin mismatch');
  requireCondition(data.env && typeof data.env === 'object' && data.env.sourceHash === pin.sourceHash && data.env.seed === seed && same(data.env, manifest.environment), 'archive environment mismatch');
  requireCondition(data.expectedHash === manifest.expectedHash && data.status === manifest.status && same(data.errors, manifest.errors) && same(data.failure, manifest.failure) && same(data.segments, manifest.segments), 'manifest content mismatch');
  requireCondition(Array.isArray(data.errors) && data.errors.every(error => typeof error === 'string'), 'invalid archive errors');
  if (legacyFailed) requireCondition(data.status === 'failed' && data.errors.length > 0, 'legacy archive is not a recorded failure');
  else requireCondition(data.status === 'complete' && data.errors.length === 0 && data.failure === null, 'incomplete archive');
  requireCondition(Array.isArray(data.expected) && Array.isArray(data.clientTrace) && Array.isArray(data.serverTruth) && data.clientTrace.every(row => row && row.side === 'client') && data.serverTruth.every(row => row && row.side === 'server'), 'invalid archive traces');
  const ledgerReserved = readBudgetWindow(budgetPath, run, config.budgetGroup);
  const evidence: Evidence = { run, sourceHash: pin.sourceHash, expectedHash: data.expectedHash, expected: data.expected, trace: [...data.clientTrace, ...data.serverTruth], budgetLimit: config.windowLimit, reserved: manifest.reserved, status: data.status };
  const errors = validateEvidence(evidence, pin.sourceHash, { config, frames: data.frames, ledgerReserved });
  const allowedIncomplete = new Set(['incomplete: failed', 'missing client pair', 'missing server pair', 'reservation mismatch']);
  requireCondition(legacyFailed ? errors.includes('incomplete: failed') && errors.every(error => allowedIncomplete.has(error)) : errors.length === 0, `invalid archived evidence: ${[...new Set(errors)].join(', ')}`);
  const planned = reconstructPlan(config, data.frames);
  requireCondition(Array.isArray(data.segments) && (legacyFailed ? data.segments.length <= 2 : data.segments.length === 2) && data.segments.every((segment, index) => {
    const name = ['normal', 'slow'][index];
    const actions = planned.filter(job => job.call.startsWith(`${name}/`) && job.call.endsWith('/1') && job.attempt === 1).length;
    return segment && segment.name === name && numeric(segment.wallMs) && Array.isArray(segment.actionWaitMs) && segment.actionWaitMs.length === actions && segment.actionWaitMs.every(numeric);
  }), 'invalid archive segments');
  const clientStarts = data.clientTrace.filter(row => row.phase === 'start').length;
  const clientEnds = data.clientTrace.filter(row => row.phase === 'end').length;
  const serverStarts = data.serverTruth.filter(row => row.phase === 'start').length;
  const serverEnds = data.serverTruth.filter(row => row.phase === 'end').length;
  requireCondition(clientStarts <= ledgerReserved && clientEnds <= clientStarts && serverStarts <= clientStarts && serverEnds <= serverStarts, 'inconsistent trace counts');
  return { manifest, planned: planned.length, ledgerReserved, clientStarts, clientEnds, serverStarts, serverEnds, recordedErrors: data.errors.length, completedSegments: data.segments.length };
}

/** Only complete, fully validated windows can be used for resume or screening. */
export async function validateArchivedWindow(path: string, value: unknown, pin: WindowPin, budgetPath: string, signal?: AbortSignal): Promise<PassiveManifest> {
  return (await inspectWindow(path, value, pin, budgetPath, false, signal)).manifest;
}

/** The pre-source-prefix failed preflight is inspectable, never resumable or successful. */
export async function inspectLegacyFailedWindow(path: string, value: unknown, pin: WindowPin, budgetPath: string, signal?: AbortSignal) {
  const result = await inspectWindow(path, value, pin, budgetPath, true, signal);
  const { manifest, ...counts } = result;
  return { run: manifest.run, status: manifest.status, sourceHash: manifest.sourceHash, inputHash: manifest.inputHash, expectedHash: manifest.expectedHash, sha256: manifest.sha256, compressedSha256: manifest.compressedSha256, ...counts, result: 'recorded_failure' as const };
}
