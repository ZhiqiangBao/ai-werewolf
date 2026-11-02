import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release, totalmem } from 'node:os';
import { getAdapter } from '@werewolf/llm';
import type { ObservationEvent } from '@werewolf/protocol';
import { createSyntheticFetch } from './synthetic-fetch';
import { buildObservationReport, renderObservationReport } from './report';
import { startSyntheticService, type SyntheticResponsePlan } from './synthetic-service';
import type { SyntheticProtocol } from './synthetic-plan';
import { gitState, sourceFingerprint } from './synthetic-run';

/** Adapter-only probes use short legal adapter budgets, without changing session limits. */
export async function runSyntheticProbe(options: { scenario: 'S10' | 'S11'; protocol: SyntheticProtocol; probe: 'before_headers' | 'after_content' | 'backoff' | 'abort'; repetition?: number }) {
  if ((options.scenario === 'S10') !== (options.probe !== 'abort')) throw new Error('Unsupported probe for this scenario');
  const sourceStart = await sourceFingerprint(), gitStart = gitState();
  const runId = `run-${randomUUID()}`, callId = `${runId}:call`;
  const root = resolve('data/diagnostics/synthetic'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'probe-'));
  const events: ObservationEvent[] = [];
  const originalFetch = globalThis.fetch;
  const service = await startSyntheticService();
  const wrapper = createSyntheticFetch<SyntheticResponsePlan>({ origins: [service.origin], register: (_origin, id, plan) => service.register(id, plan), fetch: originalFetch });
  const controller = new AbortController();
  let abortTimer: ReturnType<typeof setTimeout> | undefined, attempt = 0;
  let outcome: 'timeout' | 'cancelled' | 'other' = 'other';
  let error = false;
  let adapterWallMs: number | undefined;
  const start = performance.now();
  try {
    globalThis.fetch = wrapper.fetch;
    const result = await wrapper.run(() => ({ protocol: options.protocol, stream: true,
      call: { tool: 'synthetic_tool', args: { target: 2 } },
      headersMs: options.probe === 'before_headers' ? 1500 : 10, firstContentMs: 10, chunks: 4, chunkIntervalMs: 10,
      ...(options.probe === 'after_content' || options.probe === 'abort' ? { hangAfterContent: true } : {}),
      ...(options.probe === 'backoff' ? { status: attempt++ === 0 ? 429 : 500 } : {}),
    }), () => getAdapter('openai_compatible', options.protocol).decide({ seat: 1, messages: [],
      tools: [{ name: 'synthetic_tool', title: 'test', description: 'test', params: [] }], toolChoice: 'required', stream: true,
      config: { apiProtocol: options.protocol, baseUrl: service.origin, model: 'synthetic', apiKey: null, temperature: 0, toolMode: 'tools', timeoutSec: 1 },
      signal: controller.signal,
      observation: { clock: { monotonicMs: () => performance.now(), wallTimeMs: Date.now }, callId, emit(event) {
        events.push({ schemaVersion: 1, runId, roomRef: 'adapter-only', callId, ...event });
        if (event.kind === 'http_attempt' && event.phase === 'start') {
          wrapper.setAttempt(event.id);
          if (options.probe === 'abort' && !abortTimer) abortTimer = setTimeout(() => controller.abort(), 100);
        }
      } },
    }));
    outcome = result.failureKind === 'timeout' ? 'timeout' : result.failureKind === 'cancelled' ? 'cancelled' : 'other';
    error = outcome !== (options.probe === 'abort' ? 'cancelled' : 'timeout');
  } catch { error = true; }
  finally {
    adapterWallMs = performance.now() - start;
    if (abortTimer) clearTimeout(abortTimer);
    globalThis.fetch = originalFetch;
    await service.close();
  }
  const sourceEnd = await sourceFingerprint(), gitEnd = gitState();
  let lockSha256 = 'unknown';
  try { lockSha256 = createHash('sha256').update(await readFile('pnpm-lock.yaml')).digest('hex'); } catch { /* unavailable */ }
  const manifest = { reportKind: 'synthetic_adapter_probe', completed: !error, acceptance: 'not_evaluated', coverage: 'partial_fault_case',
    sourceRevision: gitStart.revision, sourceRevisionEnd: gitEnd.revision, sourceDirty: gitStart.dirty, sourceDirtyEnd: gitEnd.dirty,
    sourceSha256: sourceStart, sourceSha256End: sourceEnd, sourceChangedDuringRun: sourceStart !== sourceEnd || gitStart.revision !== gitEnd.revision,
    runId, callId, lockSha256,
    scenario: options.scenario, protocol: options.protocol, probe: options.probe, repetition: options.repetition ?? 1,
    node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unknown', memoryTotalBytes: totalmem(), storage: 'unknown',
    observationsEnabled: true, timeoutSec: 1, stream: true, serviceProcesses: 1, outcome, windowWallMs: adapterWallMs };
  await writeFile(resolve(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve(directory, 'observations.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(resolve(directory, 'synthetic-truth.jsonl'), service.truth.map((truth) => JSON.stringify(truth)).join('\n') + '\n');
  const summary = buildObservationReport(events);
  await writeFile(resolve(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(resolve(directory, 'report.md'), `> 本次只覆盖清单中记录的一个适配器故障边界，不代表整个场景。\n\n${renderObservationReport(summary)}`);
  if (error) throw new Error(`Synthetic probe did not reach its expected outcome; output: ${directory}`);
  return { directory, manifest };
}
