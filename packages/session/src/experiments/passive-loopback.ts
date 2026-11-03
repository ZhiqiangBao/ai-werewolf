import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as waitDelay } from 'node:timers/promises';
import { reserveAttempt, type BudgetGroup } from './passive-budget';
import { hashExpected, validateEvidence, type Evidence, type Expected, type Trace } from './passive-validator';
import { projectionHash } from './passive-projections';
import { anthropicInput, chatMessages, protocolBinding, responsesInput, type AdapterConfig, type TranscriptMessage } from '@werewolf/llm';

export type Protocol = 'chat-completions' | 'responses' | 'anthropic-messages';
export type Candidate = 'A' | 'B' | 'A+D';
export type WindowConfig = { run: string; protocol: Protocol; candidate: Candidate; rooms: 1 | 2; providers: 1 | 2; slowMs: number; baseMs: number; slots: 4 | 8; serverSlots?: 4 | 8; faultStatus?: 429 | 503; sourceHash: string; budgetPath: string; budgetGroup: BudgetGroup; totalLimit: number; windowLimit: number; projections: Record<string, [string, string]>; signal?: AbortSignal };

// The payloads deliberately differ in shape. They are synthetic native items, not
// claims of compatibility with an actual provider's complete protocol.
export function nativeItems(protocol: Protocol, id: string): string[] {
  if (protocol === 'chat-completions') return [JSON.stringify({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'listen', arguments: '{}' } }] }), JSON.stringify({ role: 'tool', tool_call_id: id, content: 'ok' })];
  if (protocol === 'responses') return [JSON.stringify({ type: 'function_call', call_id: id, name: 'listen', arguments: '{}' }), JSON.stringify({ type: 'function_call_output', call_id: id, output: 'ok' })];
  return [JSON.stringify({ type: 'thinking', thinking: 'synthetic', signature: `sig-${id}` }), JSON.stringify({ type: 'tool_use', id, name: 'listen', input: {} }), JSON.stringify({ type: 'tool_result', tool_use_id: id, content: 'ok' })];
}

export function historyIds(value: unknown): string[] {
  const out: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== 'object') return;
    const object = item as Record<string, unknown>;
    for (const key of ['call_id', 'tool_call_id', 'tool_use_id']) if (typeof object[key] === 'string') out.push(object[key] as string);
    if ((object.type === 'function' || object.type === 'tool_use') && typeof object.id === 'string') out.push(object.id);
    Object.values(object).forEach(visit);
  };
  visit(value); return out;
}

export class Slots {
  private active = 0;
  private readonly waiting: Array<{ resolve: () => void; signal?: AbortSignal; abort: () => void }> = [];
  constructor(private readonly limit: number) {}
  async use<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => {
      const entry = { resolve, signal, abort: () => { const index = this.waiting.indexOf(entry); if (index >= 0) this.waiting.splice(index, 1); signal?.removeEventListener('abort', entry.abort); reject(new Error('cancelled while waiting for slot')); } };
      this.waiting.push(entry); signal?.addEventListener('abort', entry.abort, { once: true });
      if (signal?.aborted) entry.abort();
    });
    else this.active++;
    try { signal?.throwIfAborted(); return await fn(); } finally { const next = this.waiting.shift(); if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(); } else this.active--; }
  }
}

export function closeWithTimeout(server: Pick<Server, 'close' | 'closeAllConnections'>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; server.closeAllConnections(); reject(new Error('server close timed out')); } }, timeoutMs);
    server.close(error => { if (!done) { done = true; clearTimeout(timer); if (error) reject(error); else resolve(); } });
  });
}

export function settleWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('settlement timed out')), timeoutMs);
    promise.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });
}
export function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function planWindow(config: WindowConfig): { expected: Expected[]; plans: Record<'normal' | 'slow', Expected[][][]> } {
  const expected: Expected[] = [];
  const plans = Object.fromEntries((['normal', 'slow'] as const).map(segment => {
    const seats = Array.from({ length: config.rooms * 12 }, (_, i) => `${Math.floor(i / 12) + 1}:${i % 12 + 1}`);
    const jobs = seats.map(seat => {
      const frames = config.projections[seat.split(':')[1]]; if (!frames) throw new Error('missing projection');
      const projected = JSON.parse(frames[1]) as { task?: unknown };
      const waves = frames[0] !== frames[1] && projected.task ? [0, 1] : [0];
      return waves.map(wave => {
        const call = `${segment}/${seat}/${wave}`; const projection = frames[wave];
        const previous = segment === 'normal' ? [] : [`normal/${seat}/0`, ...(waves.length === 2 ? [`normal/${seat}/1`] : [])];
        if (wave === 1) previous.push(`${segment}/${seat}/0`);
        const retry = !!config.faultStatus && seat === '1:1' && wave === 0;
        const base = { run: config.run, seat, call, projectionHash: projectionHash(projection), history: previous.flatMap(id => [id, id]) };
        const attempts: Expected[] = retry ? [{ ...base, attempt: 1, native: [], httpStatus: config.faultStatus }, { ...base, attempt: 2, native: nativeItems(config.protocol, call), httpStatus: 200 }] : [{ ...base, attempt: 1, native: nativeItems(config.protocol, call), httpStatus: 200 }];
        expected.push(...attempts); return attempts;
      });
    });
    return [segment, jobs];
  })) as Record<'normal' | 'slow', Expected[][][]>;
  return { expected, plans };
}

export async function runLoopbackWindow(config: WindowConfig): Promise<{ evidence: Evidence; clientTrace: Trace[]; serverTruth: Trace[]; errors: string[]; segments: Array<{ name: string; wallMs: number; actionWaitMs: number[] }> }> {
  if (!config.run || !Number.isFinite(config.baseMs) || config.baseMs < 0 || !Number.isFinite(config.slowMs) || config.slowMs < 0 || config.rooms > 2 || config.providers > config.rooms || config.windowLimit > 512) throw new Error('invalid configuration');
  const clientTrace: Trace[] = []; const serverTruth: Trace[] = []; const { expected, plans } = planWindow(config); const segments: Array<{ name: string; wallMs: number; actionWaitMs: number[] }> = [];
  let reserved = 0; let status: Evidence['status'] = 'complete'; let firstFailure: unknown;
  const localAbort = new AbortController(); const signal = config.signal ? AbortSignal.any([config.signal, localAbort.signal]) : localAbort.signal;
  const providerFor = (seat: string) => config.providers === 1 ? 'shared' : `provider-${seat.split(':')[0]}`;
  const serverLimits = new Map<string, Slots>();
  const pendingServer = new Set<Promise<void>>();
  const providerSlots = (map: Map<string, Slots>, provider: string, limit: number) => { let slots = map.get(provider); if (!slots) { slots = new Slots(limit); map.set(provider, slots); } return slots; };
  const server: Server = createServer((req, res) => {
    let body = ''; req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body) as { job: Expected; delay: number; projection: string; history: unknown };
        const { job, delay, projection, history } = data;
        if (typeof projection !== 'string' || projectionHash(projection) !== job.projectionHash) throw new Error('projection mismatch');
        const arrived = performance.now(); serverTruth.push({ ...job, side: 'server', phase: 'start', time: arrived, history: historyIds(history) });
        const task = providerSlots(serverLimits, providerFor(job.seat), config.serverSlots ?? Number.MAX_SAFE_INTEGER).use(async () => {
          const queueMs = performance.now() - arrived;
          await waitDelay(delay, undefined, { signal });
          const httpStatus = config.faultStatus && job.seat === '1:1' && job.call.endsWith('/0') && job.attempt === 1 ? config.faultStatus : 200;
          const native = httpStatus === 200 ? nativeItems(config.protocol, job.call) : [];
          serverTruth.push({ ...job, side: 'server', phase: 'end', time: performance.now(), native, queueMs, httpStatus });
          res.writeHead(httpStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ native }));
        }, signal);
        pendingServer.add(task); void task.then(() => pendingServer.delete(task), () => pendingServer.delete(task));
      } catch { res.writeHead(400); res.end(); }
    });
  });
  try { await waitWithSignal(new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), signal); }
  catch (error) { server.closeAllConnections(); await closeWithTimeout(server, 1000).catch(() => {}); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('loopback address');
  const url = `http://127.0.0.1:${address.port}/model`; const localLimits = new Map<string, Slots>();
  const abortConnections = () => server.closeAllConnections(); signal.addEventListener('abort', abortConnections, { once: true });
  const apiProtocol = config.protocol === 'chat-completions' ? 'chat_completions' : config.protocol === 'anthropic-messages' ? 'anthropic_messages' : 'responses';
  const adapterConfig: AdapterConfig = { apiProtocol, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic', apiKey: null, temperature: 0, timeoutSec: 10, toolMode: 'tools' };
  const histories = new Map<string, TranscriptMessage[]>();
  try {
    for (const segment of ['normal', 'slow'] as const) {
      const jobs = plans[segment];
      const began = performance.now(); const actionWaitMs: number[] = []; const listenCompleted = new Map<string, number>();
      const send = async (attempts: Expected[], wave: number) => providerSlots(localLimits, providerFor(attempts[0].seat), config.candidate === 'A+D' ? config.slots : Number.MAX_SAFE_INTEGER).use(async () => {
        if (signal.aborted) throw new Error('cancelled');
        const job = attempts[0];
        const projection = config.projections[job.seat.split(':')[1]][wave];
        const transcript: TranscriptMessage[] = [...(histories.get(job.seat) ?? []), { role: 'user', content: projection }];
        const history = apiProtocol === 'chat_completions' ? chatMessages(transcript) : apiProtocol === 'responses' ? responsesInput(transcript, adapterConfig) : anthropicInput(transcript, adapterConfig).messages;
        if (JSON.stringify(historyIds(history)) !== JSON.stringify(job.history)) throw new Error('local native history order');
        const ready = wave === 1 ? listenCompleted.get(job.seat) : undefined;
        if (wave === 1 && ready === undefined) throw new Error('action overtook listen');
        const delay = config.baseMs + (segment === 'slow' && job.seat === '1:1' && wave === 0 ? config.slowMs : 0);
        let value: { native: string[] } | undefined;
        for (const attempt of attempts) {
          if (signal.aborted) throw new Error('cancelled');
          const body = JSON.stringify({ job: attempt, delay, projection, history });
          reserveAttempt(config.budgetPath, config.run, config.totalLimit, config.windowLimit, config.budgetGroup); reserved++;
          if (ready !== undefined && attempt.attempt === 1) actionWaitMs.push(performance.now() - ready);
          clientTrace.push({ ...attempt, side: 'client', phase: 'start', time: performance.now() });
          const response = await fetch(url, { method: 'POST', body, signal });
          value = await response.json() as { native: string[] };
          clientTrace.push({ ...attempt, side: 'client', phase: 'end', time: performance.now(), native: value.native, httpStatus: response.status });
          if (response.status !== attempt.httpStatus || JSON.stringify(value.native) !== JSON.stringify(attempt.native)) throw new Error('HTTP/native response mismatch');
          if (response.ok) break;
          if (attempt === attempts.at(-1)) throw new Error('retry exhausted');
          await waitDelay(10, undefined, { signal });
        }
        if (!value) throw new Error('missing response');
        const items = value.native.slice(0, -1).map(item => JSON.parse(item));
        transcript.push({ role: 'assistant', content: null, calls: [{ id: job.call, name: 'listen', arguments: '{}' }], ...(apiProtocol === 'chat_completions' ? {} : { native: { protocol: apiProtocol, binding: protocolBinding(adapterConfig), items } }) }, { role: 'tool', callId: job.call, content: 'ok' });
        histories.set(job.seat, transcript);
        if (wave === 0) listenCompleted.set(job.seat, performance.now());
      }, signal).catch(error => { if (firstFailure === undefined) firstFailure = error; localAbort.abort(); throw error; });
      const settle = async (tasks: Promise<void>[]) => {
        const outcomes = await waitWithSignal(Promise.allSettled(tasks), signal); const rejected = outcomes.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
      };
      if (config.candidate === 'B') await settle(jobs.map(async pair => { await send(pair[0], 0); if (pair[1]) await send(pair[1], 1); }));
      else for (let wave = 0; wave < 2; wave++) await settle(jobs.flatMap(pair => pair[wave] ? [send(pair[wave], wave)] : []));
      segments.push({ name: segment, wallMs: performance.now() - began, actionWaitMs });
    }
  } catch (error) {
    status = config.signal?.aborted ? 'cancelled' : String(firstFailure ?? error).includes('budget exhausted') ? 'budget_exhausted' : 'failed';
  } finally {
    if (signal.aborted) server.closeAllConnections();
    try { await closeWithTimeout(server, 1000); } catch { status = config.signal?.aborted ? 'cancelled' : 'failed'; localAbort.abort(); }
    try { await settleWithTimeout(Promise.allSettled([...pendingServer]), 1000); } catch { status = config.signal?.aborted ? 'cancelled' : 'failed'; localAbort.abort(); }
    signal.removeEventListener('abort', abortConnections);
  }
  const evidence: Evidence = { run: config.run, sourceHash: config.sourceHash, expectedHash: hashExpected(expected), expected, trace: [...clientTrace, ...serverTruth], budgetLimit: config.windowLimit, reserved, status };
  return { evidence, clientTrace, serverTruth, errors: validateEvidence(evidence, config.sourceHash), segments };
}
