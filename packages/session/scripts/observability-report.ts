import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { AuditEntry, ObservationEvent } from '@werewolf/protocol';
import { buildObservationReport, legacyAuditObservations, renderObservationReport } from '../src/observability/report';
import type { SyntheticTruth } from '../src/observability/synthetic-service';

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: tsx packages/session/scripts/observability-report.ts data/.../observations.jsonl [legacy-audit.json]');
  const path = resolve(input), root = resolve('data'), rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Input and report output must be inside the ignored data directory');
  const text = await readFile(path, 'utf8');
  const events = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as ObservationEvent);
  if (process.argv[3]) {
    const auditPath = resolve(process.argv[3]), auditRel = relative(root, auditPath);
    if (!auditRel || auditRel.startsWith('..') || isAbsolute(auditRel)) throw new Error('Legacy audit must be inside data');
    const audits = JSON.parse(await readFile(auditPath, 'utf8')) as AuditEntry[];
    events.push(...legacyAuditObservations(audits, 'legacy-room', events));
  }
  let truth: SyntheticTruth[] = [];
  try { truth = (await readFile(resolve(dirname(path), 'synthetic-truth.jsonl'), 'utf8')).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as SyntheticTruth); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let measurementWindow: { runWallMs: number | null; roomWallMs: Record<string, number>; source: 'runner_monotonic' } | undefined;
  try {
    const manifest = JSON.parse(await readFile(resolve(dirname(path), 'manifest.json'), 'utf8')) as { windowWallMs?: unknown; roomWindowMs?: unknown };
    if (typeof manifest.windowWallMs === 'number' && manifest.roomWindowMs && typeof manifest.roomWindowMs === 'object') {
      const rooms = Object.fromEntries(Object.entries(manifest.roomWindowMs).filter(([key, value]) => /^synthetic-[AB]$/.test(key) && typeof value === 'number' && Number.isFinite(value)));
      measurementWindow = { runWallMs: manifest.windowWallMs, roomWallMs: rooms, source: 'runner_monotonic' };
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const summary = { ...buildObservationReport(events, { syntheticTruth: truth }), ...(measurementWindow ? { measurementWindow } : {}) };
  await writeFile(resolve(dirname(path), 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(resolve(dirname(path), 'report.md'), renderObservationReport(summary), 'utf8');
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Report failed'); process.exitCode = 1; });
