import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { buildRules, createGame } from '@werewolf/engine';
import { getAdapter, mockAdapter, type Adapter } from '@werewolf/llm';
import type { ObservationEvent } from '@werewolf/protocol';
import { defaultGameTiming } from '@werewolf/protocol';
import { RoomManager } from '../manager';
import { SecretBox } from '../secret';
import { FileStore, MemoryStore, type RoomStore } from '../store';
import { BufferedObservationSink } from './buffer';
import { buildObservationReport, distribution, renderObservationReport } from './report';
import { createSyntheticFetch } from './synthetic-fetch';
import { startSyntheticService, type SyntheticResponsePlan } from './synthetic-service';
import { SYNTHETIC_SCENARIOS, SYNTHETIC_SEEDS, type SyntheticProtocol } from './synthetic-plan';

export type RunnableSyntheticScenario = 'S01' | 'S02' | 'S03' | 'S04' | 'S05' | 'S06' | 'S07' | 'S08' | 'S09' | 'S12' | 'S13' | 'S14' | 'S15';
export async function sourceFingerprint(): Promise<string> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && path.endsWith('.ts')) files.push(path);
    }
  }
  for (const dir of ['packages/protocol/src', 'packages/llm/src', 'packages/session/src', 'packages/session/scripts']) await visit(dir);
  const hash = createHash('sha256');
  for (const path of files.sort()) { hash.update(path); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
  return hash.digest('hex');
}
export function gitState() {
  try { return { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim() }; }
  catch { return { revision: 'unknown', dirty: null }; }
}
/** Runs one explicit measurement, not the full acceptance plan. */
export async function runSyntheticBaseline(options: { scenario: RunnableSyntheticScenario; protocol: SyntheticProtocol; seed: typeof SYNTHETIC_SEEDS[number]; repetition?: number; warmup?: boolean; observation?: boolean; fixtureWindow?: boolean; faultCase?: string }) {
  const sourceStart = await sourceFingerprint(), gitStart = gitState();
  const scenario = SYNTHETIC_SCENARIOS.find((s) => s.id === options.scenario)!;
  const root = resolve('data/diagnostics/synthetic');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'run-'));
  const observationPath = resolve(directory, 'observations.jsonl');
  await writeFile(observationPath, '');
  const services: Awaited<ReturnType<typeof startSyntheticService>>[] = [];
  const originalFetch = globalThis.fetch;
  let manager: RoomManager | undefined;
  let collectorRuntimeStats: { callbackErrors: number; lateEvents: number; activeSpans: number } | null = null;
  let restoreFixture: (() => void) | undefined;
  const observed = options.observation !== false;
  if (!observed && !options.fixtureWindow) throw new Error('Unobserved runs require the shared runner window fixture');
  let injectPersistence = false, injectionCount = 0;
  const faultCase = options.faultCase ?? (options.scenario === 'S13' ? 'audit' : options.scenario === 'S14' ? 'reported' : options.scenario === 'S15' ? 'parse' : 'default');
  const usesFaultFixture = options.scenario === 'S15' && ['control', 'sink_throw', 'write_failure'].includes(faultCase);
  const fixtureWindow = !!options.fixtureWindow || usesFaultFixture;
  class SyntheticStore extends MemoryStore {
    private injectDelay(operation: 'save' | 'audit'): void {
      if (options.scenario !== 'S13' || faultCase !== operation || !injectPersistence || injectionCount !== 0) return;
      injectionCount++;
      const end = performance.now() + 200;
      while (performance.now() < end) { /* intentionally block one selected store operation */ }
    }
    override save(room: Parameters<MemoryStore['save']>[0]): void {
      this.injectDelay('save');
      super.save(room);
    }
    override appendAudit(roomId: string, entry: Parameters<MemoryStore['appendAudit']>[1]): void {
      this.injectDelay('audit');
      super.appendAudit(roomId, entry);
    }
  }
  const store: RoomStore = options.scenario === 'S13' && faultCase === 'file' ? new FileStore(resolve(directory, 'filestore')) : new SyntheticStore();
  const secrets = SecretBox.ephemeral();
  let events: ObservationEvent[] = [];
  const buffered = new BufferedObservationSink({ write: async (batch, encodedLines) => {
    if (options.scenario === 'S15' && faultCase === 'write_failure' && injectPersistence && injectionCount === 0) {
      injectionCount++;
      throw new Error('synthetic diagnostic write failure');
    }
    await appendFile(observationPath, encodedLines?.join('') ?? batch.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } });
  const waveCounts = new Map<string, number>();
  const pauseRequested = new Set<string>();
  const callDurations: number[] = [], heaps: number[] = [];
  const fixtureWork = new Map<string, { seatRef: string; purpose: string }[][]>();
  const requestSequence: { roomRef: string; wave: number; seatRef: string; purpose: string; ordinal: number; variants: string[]; attempts: number[]; outcome: string }[] = [];
  const callOrdinals = new Map<string, number>();
  let syntheticCallSerial = 0;
  let selectedCallId: string | undefined;
  const endReasons: Record<string, string> = {};
  const roomStart = new Map<string, number>(), roomEnd = new Map<string, number>();
  const timing = defaultGameTiming();
  for (const value of Object.values(timing)) value.intervalMs = 0;
  const roomIds = scenario.topology === 'single' ? ['synthetic-A'] : ['synthetic-A', 'synthetic-B'];
  const aliases = new Map(roomIds.map((id, i) => [`r${i + 1}`, id]));
  const sink = { emit(event: ObservationEvent) {
    buffered.emit(event);
    if (!fixtureWindow && event.kind === 'wave' && event.phase === 'end' && (event.members ?? 0) > 0) {
      const n = (waveCounts.get(event.roomRef) ?? 0) + 1; waveCounts.set(event.roomRef, n);
      const roomId = aliases.get(event.roomRef);
      if (n === 30 && roomId && !pauseRequested.has(roomId)) {
        pauseRequested.add(roomId);
        roomEnd.set(roomId, performance.now());
        // Runner-only wave watcher: pausing in a microtask starts a 31st wave first.
        try { manager?.control(roomId, 'host', 'pause'); } catch { /* natural end */ }
      }
    }
    if (options.scenario === 'S15' && faultCase === 'sink_throw' && injectPersistence && injectionCount === 0 && event.kind === 'http_attempt' && event.phase === 'start') {
      injectionCount++;
      throw new Error('synthetic observation callback failure');
    }
  } };
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const samplerWarmupMs = 20;
  let samplerStartedAt: number | undefined, eventLoopSampleWindowMs: number | null = null;
  let samplerWarmupActualMs: number | null = null, samplerWarmupSamples: number | null = null;
  const stopSampler = () => {
    if (samplerStartedAt === undefined || eventLoopSampleWindowMs !== null) return;
    loop.disable();
    eventLoopSampleWindowMs = performance.now() - samplerStartedAt;
  };
  let cpu: NodeJS.CpuUsage | null = null, elu: number | null = null, wallMs: number | null = null;
  let error: string | undefined;
  try {
    services.push(await startSyntheticService());
    if (options.scenario === 'S03') services.push(await startSyntheticService());
    const wrapper = createSyntheticFetch<SyntheticResponsePlan>({ origins: services.map((service) => service.origin),
      register: (origin, id, plan) => services.find((service) => service.origin === origin)!.register(id, plan) });
    globalThis.fetch = wrapper.fetch;
    const adapter: Adapter = { async decide(req) {
      if (observed && !req.observation) throw new Error('Synthetic baseline requires adapter observations');
      const decision = await mockAdapter.decide(req);
      if (!decision.ok) throw new Error('Synthetic decision unavailable');
      const purpose = req.toolChoice === 'auto' ? 'listen' : 'action';
      const targetPurpose = ['S05', 'S08', 'S09', 'S15'].includes(options.scenario) ? 'action' : 'listen';
      const remoteFault = options.scenario === 'S15' && ['parse', 'disconnect', 'no_content', 'local_config'].includes(faultCase);
      const selected = req.seat === 1 && purpose === targetPurpose && injectionCount === 0 && (options.scenario !== 'S15' || remoteFault);
      if (selected && remoteFault) selectedCallId = req.observation?.callId;
      if (selected && (['S04', 'S05', 'S07', 'S08', 'S12'].includes(options.scenario) || remoteFault || (options.scenario === 'S09' && options.protocol === 'chat_completions'))) injectionCount++;
      if (selected && options.scenario === 'S12') {
        const end = performance.now() + 200;
        while (performance.now() < end) { /* intentionally block this client process */ }
      }
      const port = req.observation;
      const remote = getAdapter('openai_compatible', options.protocol);
      const headersMs = options.scenario === 'S03' && req.config.baseUrl === services[1].origin ? 80 : 20;
      let attempt = 0, stream = options.scenario !== 'S06' && !!req.stream;
      const syntheticCallId = `fixture-${++syntheticCallSerial}`;
      let fallbackAttempt = 0;
      const roomRef = `r${roomIds.indexOf(req.projection?.gameId ?? '') + 1}`;
      const wave = waveCounts.get(roomRef) ?? 0, ordinalKey = `${roomRef}:${wave}:${req.seat}:${purpose}`;
      const ordinal = (callOrdinals.get(ordinalKey) ?? 0) + 1;
      if (usesFaultFixture) callOrdinals.set(ordinalKey, ordinal);
      const trace = usesFaultFixture ? { roomRef, wave, seatRef: `s${req.seat}`, purpose, ordinal, variants: [] as string[], attempts: [] as number[], outcome: 'local_error' } : undefined;
      const started = performance.now();
      try { const result = await wrapper.run(() => {
        const index = attempt++;
        const compatibility = options.faultCase ?? 'stream';
        const rejectedVariant = selected && options.scenario === 'S09' && options.protocol === 'chat_completions'
          ? compatibility === 'combined' ? (index === 0 ? 'unsupported_stream' : index === 1 ? 'unsupported_tool_choice' : undefined)
            : index === 0 ? ({ stream: 'unsupported_stream', required: 'unsupported_tool_choice', json: 'unsupported_json' } as const)[compatibility as 'stream' | 'required' | 'json'] : undefined
          : undefined;
        return { protocol: options.protocol,
        call: selected && options.scenario === 'S08' ? { tool: 'synthetic_invalid_tool', args: {} } : decision.call,
        stream, headersMs: headersMs + (selected && options.scenario === 'S04' ? 500 : 0), firstContentMs: 30,
        chunks: selected && options.scenario === 'S05' ? 100 : 4, chunkIntervalMs: 10,
        ...(selected && options.scenario === 'S07' && options.faultCase !== 'network' ? { status: [429, 500, 200][Math.min(index, 2)] } : {}),
        ...(selected && options.scenario === 'S07' && options.faultCase === 'network' && index === 0 ? { disconnect: true } : {}),
        ...(rejectedVariant ? { status: 400, errorKind: rejectedVariant } : {}),
        ...(selected && options.scenario === 'S09' && options.protocol === 'chat_completions' && compatibility === 'json' ? { jsonMode: true } : {}),
        ...(selected && options.scenario === 'S15' && faultCase === 'parse' ? { malformed: true } : {}),
        ...(selected && options.scenario === 'S15' && faultCase === 'disconnect' ? { disconnectAfterContent: true } : {}),
        ...(selected && options.scenario === 'S15' && faultCase === 'no_content' ? { noContent: true } : {}),
        ...(options.scenario === 'S14' ? { capacity: 1 } : {}),
        ...(options.scenario === 'S14' && faultCase === 'omitted' ? { omitQueue: true } : {}),
      }; }, () => remote.decide({ ...req, stream,
          ...(selected && options.scenario === 'S09' && options.protocol === 'chat_completions' && options.faultCase === 'json' ? { config: { ...req.config, toolMode: 'json' as const } } : {}),
          ...(selected && options.scenario === 'S15' && faultCase === 'local_config' ? { config: { ...req.config, baseUrl: 'invalid synthetic URL' } } : {}),
          ...(port ? { observation: { ...port, emit(event) {
            if (event.kind === 'http_request' && event.phase === 'start' && event.features) stream = event.features.stream;
            if (trace && event.kind === 'http_request' && event.phase === 'start') trace.variants.push(`${event.variantReason ?? 'initial'}:${event.features?.stream ?? 'unknown'}`);
            if (trace && event.kind === 'http_attempt' && event.phase === 'start') trace.attempts.push(event.attemptIndex ?? 0);
            if (event.kind === 'http_attempt' && event.phase === 'start') wrapper.setAttempt(event.id);
            port.emit(event);
          } } } : {}),
        }), observed ? undefined : () => `${syntheticCallId}:${++fallbackAttempt}`);
        if (trace) trace.outcome = result.ok ? 'success' : result.failureKind ?? 'invalid_tool';
        return result;
      } finally { if (trace) requestSequence.push(trace); callDurations.push(performance.now() - started); }
    } };
    const initialStore = new MemoryStore();
    const initial = new RoomManager({ store: initialStore, secrets, tickMs: 0 });
    for (const _id of roomIds) initial.createRoom();
    initial.dispose();
    const templates = initialStore.loadAll();
    for (const [index, id] of roomIds.entries()) {
      const rec = templates[index];
      const seed = roomIds.length === 1 ? options.seed : `${options.seed}-${index ? 'B' : 'A'}`;
      const rules = buildRules('standard12');
      const { state, events: gameEvents } = createGame({ id, rules, seed });
      Object.assign(rec, { id, hostToken: 'host', spectatorToken: 'spectator', seatTokens: Array.from({ length: 12 }, (_, i) => `seat-${i + 1}`),
        seed, rules, state, events: gameEvents, actions: [], deadlines: {}, status: 'running', paused: true, aiPacingMs: 0, presetId: 'standard12', timing });
      for (const seat of rec.seats) Object.assign(seat, { controller: 'ai', adapter: 'openai_compatible', apiProtocol: options.protocol,
        baseUrl: services[options.scenario === 'S03' ? index : 0].origin, model: 'synthetic', apiKeyEnc: null, apiKeyMask: null, toolMode: 'tools' });
      store.save(rec);
    }
    manager = new RoomManager({ store, secrets, tickMs: 0, adapters: { openai_compatible: adapter },
      ...(observed ? { observability: { sink, mappingPath: resolve(directory, 'identities.json') } } : {}) });
    if (fixtureWindow) {
      type FixtureRuntime = { prepareWave(live: { rec: { id: string } }): { seat: number; action: boolean }[] | null };
      const runtime = (manager as unknown as { runtime: FixtureRuntime }).runtime;
      const original = runtime.prepareWave;
      runtime.prepareWave = function (live) {
        const index = roomIds.indexOf(live.rec.id), alias = `r${index + 1}`;
        const count = waveCounts.get(alias) ?? 0;
        if (count >= 30) {
          if (!pauseRequested.has(live.rec.id)) {
            pauseRequested.add(live.rec.id); roomEnd.set(live.rec.id, performance.now());
            manager!.control(live.rec.id, 'host', 'pause');
          }
          return null;
        }
        const wave = original.call(runtime, live);
        if (wave?.length) {
          waveCounts.set(alias, count + 1);
          if (count >= 10) heaps.push(process.memoryUsage().heapUsed);
          const list = fixtureWork.get(alias) ?? [];
          list.push(wave.map((item) => ({ seatRef: `s${item.seat}`, purpose: item.action ? 'action' : 'listen' }))
            .sort((a, b) => a.seatRef.localeCompare(b.seatRef) || a.purpose.localeCompare(b.purpose)));
          fixtureWork.set(alias, list);
        }
        return wave;
      };
      restoreFixture = () => { runtime.prepareWave = original; };
    }
    loop.enable();
    samplerStartedAt = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, samplerWarmupMs));
    while (loop.count === 0) {
      const remaining = 1000 - (performance.now() - samplerStartedAt);
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)));
    }
    samplerWarmupActualMs = performance.now() - samplerStartedAt;
    samplerWarmupSamples = loop.count;
    if (samplerWarmupSamples === 0) throw new Error('Event-loop sampler did not initialize');
    const cpuStart = process.cpuUsage(), eluStart = performance.eventLoopUtilization(), wallStart = performance.now();
    injectPersistence = true;
    for (const roomId of roomIds) { roomStart.set(roomId, performance.now()); manager.control(roomId, 'host', 'resume'); }
    await Promise.all(roomIds.map(async (roomId) => { await manager!.whenIdle(roomId); if (!roomEnd.has(roomId)) roomEnd.set(roomId, performance.now()); }));
    wallMs = Math.max(...roomEnd.values()) - wallStart;
    cpu = process.cpuUsage(cpuStart); elu = performance.eventLoopUtilization(eluStart).utilization;
    stopSampler();
    for (const [index, roomId] of roomIds.entries()) {
      const room = manager.view(roomId, 'host').room, waves = waveCounts.get(`r${index + 1}`) ?? 0;
      if (room.status === 'ended' && waves > 0 && waves <= 30) endReasons[roomId] = 'natural_end';
      else if (room.paused && waves === 30) endReasons[roomId] = '30_nonempty_waves';
      else throw new Error('Synthetic run ended before a verified stop condition');
    }
    if ((['S04', 'S05', 'S07', 'S08', 'S12'].includes(options.scenario) ||
      (options.scenario === 'S13' && faultCase !== 'file') || (options.scenario === 'S15' && faultCase !== 'control') ||
      (options.scenario === 'S09' && options.protocol === 'chat_completions')) && injectionCount !== 1)
      throw new Error('Requested synthetic injection was not exercised');
  } catch (caught) { error = caught instanceof Error ? caught.message : 'synthetic run failed'; }
  finally {
    stopSampler();
    restoreFixture?.();
    manager?.dispose();
    const internal = (manager as unknown as { observability?: { stats: { callbackErrors: number; lateEvents: number; activeSpans: number } } } | undefined)?.observability;
    globalThis.fetch = originalFetch;
    await buffered.close();
    for (const service of services) await service.close();
    if (internal) collectorRuntimeStats = { ...internal.stats };
  }
  const sourceEnd = await sourceFingerprint(), gitEnd = gitState();
  let lockSha256 = 'unknown';
  try { lockSha256 = createHash('sha256').update(await readFile('pnpm-lock.yaml')).digest('hex'); } catch { /* unavailable */ }
  events = (await readFile(observationPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ObservationEvent);
  const truth = services.flatMap((service) => service.truth);
  let faultVerified: boolean | null = null;
  if (options.scenario === 'S13') {
    if (faultCase === 'file') {
      faultVerified = ['store_save', 'audit_append'].every((operation) => events.some((event) => event.kind === 'local_span' && event.phase === 'end' && event.operation === operation));
    } else {
      const operation = faultCase === 'save' ? 'store_save' : 'audit_append';
      faultVerified = events.some((event) => event.kind === 'local_span' && event.phase === 'end' && event.operation === operation &&
        typeof event.metrics?.persistenceMs?.valueMs === 'number' && event.metrics.persistenceMs.valueMs >= 150);
    }
  } else if (options.scenario === 'S14') {
    faultVerified = truth.length > 0 && truth.every((item) => item.planned.capacity === 1 &&
      (faultCase === 'omitted' ? item.queueMs === null : typeof item.queueMs === 'number'));
  } else if (options.scenario === 'S15') {
    const selectedEvents = events.filter((event) => selectedCallId && event.callId === selectedCallId);
    if (faultCase === 'control') faultVerified = injectionCount === 0 && buffered.stats.dropped === 0 && collectorRuntimeStats?.callbackErrors === 0;
    else if (faultCase === 'sink_throw') faultVerified = (collectorRuntimeStats?.callbackErrors ?? 0) >= 1 && buffered.stats.dropped === 0;
    else if (faultCase === 'write_failure') faultVerified = buffered.stats.writeErrors >= 1 && buffered.stats.dropped > 0;
    else if (faultCase === 'local_config') faultVerified = selectedEvents.some((event) => event.kind === 'adapter_execution' && event.phase === 'end' && event.outcome === 'local_error') &&
      !selectedEvents.some((event) => event.kind === 'http_attempt' && event.phase === 'start');
    else if (faultCase === 'parse') faultVerified = selectedEvents.some((event) => event.kind === 'http_attempt' && event.phase === 'end' && event.outcome === 'parse_error');
    else if (faultCase === 'no_content') faultVerified = selectedEvents.some((event) => event.kind === 'http_attempt' && event.phase === 'end' && event.metrics?.firstStreamContentMs?.valueMs === null);
    else if (faultCase === 'disconnect') faultVerified = selectedEvents.some((event) => event.kind === 'http_attempt' && event.phase === 'end' &&
      event.outcome !== 'success' && typeof event.metrics?.firstStreamContentMs?.valueMs === 'number');
    else faultVerified = false;
  }
  if (faultVerified === false) error ??= 'requested synthetic fault was not verified';
  const workload = [...aliases.keys()].map((roomRef) => {
    if (fixtureWindow) return { roomRef, waves: fixtureWork.get(roomRef) ?? [] };
    const waves = events.filter((e) => e.kind === 'wave' && e.phase === 'start' && e.roomRef === roomRef);
    return { roomRef, waves: waves.map((wave) => events.filter((e) => e.kind === 'work' && e.phase === 'start' && e.waveId === wave.id)
      .map((work) => ({ seatRef: work.seatRef ?? 'unknown', purpose: work.purpose ?? 'unknown' }))
      .sort((a, b) => a.seatRef.localeCompare(b.seatRef) || a.purpose.localeCompare(b.purpose))).filter((wave) => wave.length) };
  });
  const workloadSha256 = createHash('sha256').update(JSON.stringify(workload)).digest('hex');
  requestSequence.sort((a, b) => a.roomRef.localeCompare(b.roomRef) || a.wave - b.wave || a.seatRef.localeCompare(b.seatRef) || a.purpose.localeCompare(b.purpose) || a.ordinal - b.ordinal);
  const requestSequenceSha256 = usesFaultFixture ? createHash('sha256').update(JSON.stringify(requestSequence)).digest('hex') : null;
  const manifest = { reportKind: 'synthetic_measurement', completed: !error, error: error ? 'run_failed' : undefined,
    scope: 'single_run_not_formal_acceptance', sourceRevision: gitStart.revision, sourceRevisionEnd: gitEnd.revision,
    sourceDirty: gitStart.dirty, sourceDirtyEnd: gitEnd.dirty, sourceSha256: sourceStart, sourceSha256End: sourceEnd,
    sourceChangedDuringRun: sourceStart !== sourceEnd || gitStart.revision !== gitEnd.revision,
    lockSha256, node: process.version, os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown', memoryTotalBytes: totalmem(), memoryFreeBytes: freemem(), storage: 'unknown',
    scenario: options.scenario, protocol: options.protocol, seed: options.seed, topology: scenario.topology, injection: scenario.injection,
    roomCount: roomIds.length, serviceProcesses: services.length, waveCounts: Object.fromEntries(waveCounts),
    endReasons,
    workloadSha256,
    selectedInjectionCount: injectionCount,
    faultCase, persistenceBackend: options.scenario === 'S13' && faultCase === 'file' ? 'file' : 'memory',
    faultVerified, diagnosticsStatus: options.scenario === 'S15' && faultCase === 'write_failure' ? 'incomplete_expected' :
      options.scenario === 'S15' && faultCase === 'sink_throw' ? 'callback_error_expected' : 'normal',
    sequenceEvidence: { adapterCalls: syntheticCallSerial, syntheticHttpAttempts: truth.length, requestSequenceSha256 },
    observationsEnabled: observed, windowFixture: fixtureWindow ? 'prepareWave_wrapper' : 'wave_end_watcher',
    stream: options.scenario !== 'S06', repetition: options.repetition ?? 1, warmup: options.warmup ?? false, intervalMs: 0, timing,
    scenarioCoverage: ['S01', 'S02', 'S03'].includes(options.scenario) ? 'basic_topology_only' : 'partial_fault_case', acceptance: 'not_evaluated',
    samplerResolutionMs: 10, samplerWarmupMs, samplerWarmupActualMs, samplerWarmupSamples,
    eventLoopSampleWindowMs, eventLoopSampleIncludesWarmup: true,
    eventLoopDelayMs: { mean: Number.isFinite(loop.mean) ? loop.mean / 1e6 : null, p95: loop.percentile(95) / 1e6,
      max: loop.count > 0 ? loop.max / 1e6 : null },
    eventLoopUtilization: elu, cpuMicros: cpu, windowWallMs: wallMs,
    fixtureCallMs: distribution(callDurations.map((valueMs) => ({ valueMs, source: 'client' }))),
    fixtureHeapBytes: heaps.length ? { samples: heaps.length, median: heaps.sort((a, b) => a - b)[Math.ceil(heaps.length / 2) - 1] } : null,
    roomWindowMs: Object.fromEntries(roomIds.filter((id) => roomStart.has(id) && roomEnd.has(id)).map((id) => [id, roomEnd.get(id)! - roomStart.get(id)!])),
    collector: buffered.stats, collectorRuntime: collectorRuntimeStats };
  await writeFile(resolve(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve(directory, 'workload.json'), `${JSON.stringify(workload, null, 2)}\n`);
  if (usesFaultFixture) await writeFile(resolve(directory, 'request-sequence.json'), `${JSON.stringify(requestSequence, null, 2)}\n`);
  await writeFile(resolve(directory, 'synthetic-truth.jsonl'), truth.map((item) => JSON.stringify(item)).join('\n') + '\n');
  const summary = { ...buildObservationReport(events, { syntheticTruth: truth }), measurementWindow: {
    runWallMs: wallMs, roomWallMs: manifest.roomWindowMs, source: 'runner_monotonic' as const,
  }, diagnostics: { status: manifest.diagnosticsStatus, collector: manifest.collector, collectorRuntime: manifest.collectorRuntime } };
  await writeFile(resolve(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const notice = error ? '运行失败或未完成；详见 manifest。' : manifest.diagnosticsStatus === 'incomplete_expected'
    ? '本次有意注入诊断写失败，观测记录不完整；不得用于准确性验收。' : manifest.diagnosticsStatus === 'callback_error_expected'
      ? '本次有意注入观测回调异常；采集异常计数见 summary 和 manifest，不构成正式验收。' : '一次本机模拟测量；不构成正式验收。';
  await writeFile(resolve(directory, 'report.md'), `> ${notice}\n\n${renderObservationReport(summary)}\n测量窗口和各桌经过时间见 summary.json 的 measurementWindow；收集器的 run/room 段按其自身生命周期统计。独立服务真值见 synthetic-truth.jsonl。\n`);
  if (error) throw new Error(`Synthetic run failed; diagnostic output: ${directory}`);
  return { directory, manifest };
}
