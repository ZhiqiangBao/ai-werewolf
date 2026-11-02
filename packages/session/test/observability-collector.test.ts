import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservationClock, ObservationEvent } from '@werewolf/protocol';
import { BufferedObservationSink } from '../src/observability/buffer';
import { RoomObservability, whitelistObservation } from '../src/observability/collector';
import { ObservationIdentities } from '../src/observability/identity';
import type { SeatRecord } from '../src/store';

const ref = { schemaVersion: 1 as const, runId: 'run-1', roomRef: 'room-1' };
const row = (id: string): ObservationEvent => ({ ...ref, kind: 'model_call', phase: 'start', id, atMs: 0 });
const dirs: string[] = [];
const mappingFile = () => { const dir = mkdtempSync(join(tmpdir(), 'werewolf-observation-')); dirs.push(dir); return join(dir, 'identities.json'); };
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('observation collector lifecycle', () => {
  it('does not coerce private objects into allowed enum or measurement fields', () => {
    const disguised = (value: string) => ({ privateText: 'nested-private-sentinel', toString: () => value });
    const unsafe = { ...row('coercion'), outcome: disguised('success'),
      metrics: { modelCallMs: { valueMs: 10, source: disguised('client') }, headersMs: { valueMs: null, reason: disguised('not_observable') } },
      features: { stream: true, responseFormat: false, toolChoice: disguised('auto'), compatibilityMemory: disguised('warm') },
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, completeness: disguised('complete') },
    } as unknown as ObservationEvent;
    const safe = whitelistObservation(unsafe);
    expect(JSON.stringify(safe)).not.toContain('nested-private-sentinel');
    expect(safe.outcome).toBeUndefined();
    expect(safe.metrics).toEqual({});
    expect(safe.features?.toolChoice).toBe('none');
    expect(safe.usage?.completeness).toBe('unknown');
  });
  it('uses monotonic time across wall-clock jumps and closes each span once', () => {
    vi.useFakeTimers();
    let monotonic = 100, wall = 10_000;
    const clock: ObservationClock = { monotonicMs: () => monotonic, wallTimeMs: () => wall };
    const events: ObservationEvent[] = [];
    const collector = new RoomObservability({ clock, sink: { emit: (event) => events.push(event) }, mappingPath: mappingFile() });
    const span = collector.begin('model_call', { ...ref, runId: collector.runId }, {}, 'call-1');
    monotonic = 125; wall = -99_000;
    span.finish('success');
    monotonic = 999; wall = 900_000;
    span.finish('cancelled');
    const end = events.filter((event) => event.id === 'call-1' && event.phase === 'end');
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ outcome: 'success', durationMs: { valueMs: 25, source: 'client' } });
    collector.finish(); collector.finish();
    expect(collector.stats.activeSpans).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires unfinished children after 60 seconds without resurrecting them on late events', () => {
    vi.useFakeTimers();
    let monotonic = 0;
    const events: ObservationEvent[] = [];
    const collector = new RoomObservability({ clock: { monotonicMs: () => monotonic, wallTimeMs: () => 0 }, sink: { emit: (event) => events.push(event) }, mappingPath: mappingFile() });
    const callRef = { ...ref, runId: collector.runId, callId: 'call-1' };
    const call = collector.begin('model_call', callRef, {}, 'call-1');
    const port = collector.adapter(callRef);
    port.emit({ kind: 'http_attempt', phase: 'start', id: 'call-1:1', parentId: 'call-1', atMs: 0 });
    monotonic = 10; call.finish('cancelled');
    monotonic = 60_010; vi.advanceTimersByTime(61_000);
    expect(events.filter((event) => event.id === 'call-1:1' && event.phase === 'end')).toMatchObject([{ outcome: 'incomplete' }]);
    const activeBefore = collector.stats.activeSpans;
    port.emit({ kind: 'http_attempt', phase: 'end', id: 'call-1:1', parentId: 'call-1', atMs: 60_011, outcome: 'success' });
    port.emit({ kind: 'http_attempt', phase: 'start', id: 'call-1:2', parentId: 'call-1', atMs: 60_012 });
    expect(collector.stats.activeSpans).toBe(activeBefore);
    expect(events.some((event) => event.id === 'call-1:2')).toBe(false);
    expect(collector.stats.lateEvents).toBeGreaterThanOrEqual(2);
    collector.finish();
    expect(collector.stats.activeSpans).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains actual child spans that start while a cancelled caller awaits underlying cleanup', () => {
    vi.useFakeTimers();
    let monotonic = 0;
    const events: ObservationEvent[] = [];
    const collector = new RoomObservability({ clock: { monotonicMs: () => monotonic, wallTimeMs: () => 0 }, sink: { emit: (event) => events.push(event) }, mappingPath: mappingFile() });
    const callRef = { ...ref, runId: collector.runId, callId: 'call-1' };
    const call = collector.begin('model_call', callRef, {}, 'call-1');
    const port = collector.adapter(callRef);
    monotonic = 10; call.finish('cancelled');
    monotonic = 20; port.emit({ kind: 'http_attempt', phase: 'start', id: 'call-1:1', parentId: 'call-1', atMs: 20 });
    monotonic = 30; port.emit({ kind: 'http_attempt', phase: 'end', id: 'call-1:1', parentId: 'call-1', atMs: 30, outcome: 'cancelled' });
    expect(events.filter((event) => event.id === 'call-1:1').map((event) => event.phase)).toEqual(['start', 'end']);
    collector.finish();
    expect(collector.stats.activeSpans).toBe(0);
  });

  it('contains a throwing sink and counts its errors without changing the measured work', () => {
    const collector = new RoomObservability({ sink: { emit: () => { throw new Error('sink-private-error'); } }, mappingPath: mappingFile() });
    expect(collector.measure('store_save', { id: 'private-room' }, () => 42)).toBe(42);
    expect(() => collector.measure('audit_append', undefined, () => { throw new Error('original-work-error'); })).toThrow('original-work-error');
    collector.finish();
    expect(collector.stats.callbackErrors).toBeGreaterThan(0);
    expect(collector.stats.activeSpans).toBe(0);
  });

  it('anonymizes custom adapter identifiers and keeps caller references under session ownership', () => {
    const events: ObservationEvent[] = [];
    const collector = new RoomObservability({ sink: { emit: (event) => events.push(event) }, mappingPath: mappingFile() });
    const callId = collector.id('call');
    const callRef = { ...collector.ref({ id: 'private-room' }, 1, 'private-decision'), callId };
    const call = collector.begin('model_call', callRef, {}, callId);
    const port = collector.adapter(callRef);
    const unsafe = { kind: 'http_attempt', phase: 'start', id: 'private-key-valid-identifier', parentId: callId,
      httpAttemptId: 'private-key-valid-identifier', requestId: 'private-request', atMs: 1,
      runId: 'private-run', roomRef: 'private-room-ref', seatRef: 'private-seat', decisionRef: 'private-decision-ref',
      providerId: 'private-provider', modelKey: 'private-model', causedByCallId: 'private-cause',
    } as const;
    port.emit(unsafe);
    port.emit({ ...unsafe, phase: 'end', atMs: 2, outcome: 'success', usage: {
      inputTokens: 1, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null,
      completeness: 'partial', sourceHttpAttemptId: unsafe.id,
    } });
    call.finish('success'); collector.finish();
    expect(JSON.stringify(events)).not.toContain('private-');
    const attempts = events.filter((event) => event.kind === 'http_attempt');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ ...callRef, id: `${callId}:external:1`, httpAttemptId: `${callId}:external:1` });
    expect(attempts[1].usage?.sourceHttpAttemptId).toBe(attempts[0].id);
    expect(unsafe.id).toBe('private-key-valid-identifier');
    expect(collector.stats.callbackErrors).toBe(0);
  });

  it('releases historical decisions and caller grace records without keeping permanent tombstones', () => {
    vi.useFakeTimers();
    let monotonic = 0;
    const collector = new RoomObservability({ clock: { monotonicMs: () => monotonic, wallTimeMs: () => 0 },
      sink: { emit: () => {} }, mappingPath: mappingFile() });
    const first = collector.ref({ id: 'room' }, 1, 'first-decision').decisionRef;
    let lastPort!: ReturnType<RoomObservability['adapter']>;
    for (let i = 0; i < 1000; i++) {
      const callId = collector.id('call');
      const callRef = { ...collector.ref({ id: 'room' }, 1, `decision-${i}`), callId };
      const call = collector.begin('model_call', callRef, {}, callId);
      lastPort = collector.adapter(callRef);
      call.finish('success');
    }
    const state = collector as unknown as { decisions: Map<string, unknown>; endedCalls: Map<string, unknown>; rooms: Map<string, unknown> };
    expect(state.decisions.size).toBe(1);
    expect(collector.ref({ id: 'room' }, 1, 'first-decision').decisionRef).toBe(first);
    monotonic = 60_001; vi.advanceTimersByTime(61_000);
    expect(state.endedCalls.size).toBe(0);
    expect(collector).not.toHaveProperty('expiredCalls');
    const active = collector.stats.activeSpans;
    lastPort.emit({ kind: 'http_attempt', phase: 'start', id: 'late-child', atMs: monotonic });
    expect(collector.stats.activeSpans).toBe(active);
    expect(collector.stats.lateEvents).toBeGreaterThan(0);
    collector.finish();
    collector.ref({ id: 'late-room' }, 1, 'late-decision');
    expect(state.decisions.size).toBe(0);
    expect(state.rooms.size).toBe(0);
    expect(collector.stats.activeSpans).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('projects arbitrary input onto numeric, enum and identifier fields only', () => {
    const input = { ...row('call-1'), messages: ['private-message'], response: 'private-response',
      apiKey: 'private-key', url: 'https://private-host/path?key=private-query', error: 'private-error',
      features: { stream: true, toolChoice: 'required', responseFormat: false, hidden: 'private-feature' },
      metrics: { headersMs: { valueMs: 10, source: 'client', hidden: 'private-metric' }, bad: 'private-bad' },
      usage: { inputTokens: 0, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, completeness: 'partial', hidden: 'private-usage' },
    } as unknown as ObservationEvent;
    const projected = whitelistObservation(input);
    expect(projected).toMatchObject({ id: 'call-1', metrics: { headersMs: { valueMs: 10, source: 'client' } }, usage: { inputTokens: 0, outputTokens: null } });
    expect(JSON.stringify(projected)).not.toMatch(/private-|https:/);
  });
});

describe('bounded observation output', () => {
  it('reuses the byte-counted JSON lines without changing the written record stream', async () => {
    const records = [row('one'), row('two')];
    const written: string[] = [];
    const sink = new BufferedObservationSink({ write: async (events, encoded) => {
      expect(encoded?.map((line) => JSON.parse(line))).toEqual(events);
      written.push(...encoded!);
    } });
    for (const record of records) sink.emit(record);
    await sink.close();
    expect(written.join('')).toBe(records.map((record) => `${JSON.stringify(record)}\n`).join(''));
    expect(sink.stats.writtenBytes).toBe(Buffer.byteLength(written.join('')));
    expect(sink.stats.bufferedRecords).toBe(0);
  });
  it('counts the in-flight batch towards the limit, drops overflow, and drains on close', async () => {
    let finishWrite!: () => void;
    const batches: readonly ObservationEvent[][] = [];
    const sink = new BufferedObservationSink({ maxRecords: 2, batchSize: 1, flushMs: 1000, write: async (events) => {
      (batches as ObservationEvent[][]).push([...events]);
      if (batches.length === 1) await new Promise<void>((resolve) => { finishWrite = resolve; });
    } });
    sink.emit(row('one'));
    const first = sink.flush();
    sink.emit(row('two'));
    sink.emit(row('three'));
    expect(sink.stats).toMatchObject({ bufferedRecords: 2, peakRecords: 2, dropped: 1, writtenRecords: 0 });
    let closed = false;
    const closing = sink.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    finishWrite();
    await Promise.all([first, closing]);
    expect(batches.map((batch) => batch[0].id)).toEqual(['one', 'two']);
    expect(sink.stats).toMatchObject({ bufferedRecords: 0, bufferedBytes: 0, dropped: 1, writtenRecords: 2 });
  });

  it('flushes immediately when a later item reaches the batch threshold', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const sink = new BufferedObservationSink({ maxRecords: 3, batchSize: 2, flushMs: 1000, write });
    sink.emit(row('one'));
    sink.emit(row('two'));
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
    await sink.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accounts for failed writes and releases its timer and capacity', async () => {
    vi.useFakeTimers();
    const sink = new BufferedObservationSink({ maxBytes: 10_000, flushMs: 50, write: async () => { throw new Error('disk-private-error'); } });
    sink.emit(row('one'));
    await vi.advanceTimersByTimeAsync(50);
    await sink.close();
    expect(sink.stats).toMatchObject({ writeErrors: 1, dropped: 1, bufferedRecords: 0, bufferedBytes: 0, writtenRecords: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the byte limit independently of record count', async () => {
    const first = row('one');
    const limit = Buffer.byteLength(JSON.stringify(first)) + 1;
    const sink = new BufferedObservationSink({ maxRecords: 10, maxBytes: limit, write: async () => {} });
    sink.emit(first); sink.emit(row('two'));
    expect(sink.stats).toMatchObject({ bufferedRecords: 1, bufferedBytes: limit, dropped: 1, peakBytes: limit });
    await sink.close();
    expect(sink.stats.bufferedBytes).toBe(0);
  });
});

describe('provider and model identities', () => {
  it('maps prototype-like model names to distinct stable IDs across instances', () => {
    const file = mappingFile();
    const first = new ObservationIdentities(file);
    const names = ['constructor', 'toString', '__proto__'];
    const ids = names.map((name) => first.model(name));
    expect(ids.every((id) => /^m-[a-f0-9-]{36}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(names.length);
    const reloaded = new ObservationIdentities(file);
    expect(names.map((name) => reloaded.model(name))).toEqual(ids);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, string> };
    for (let i = 0; i < names.length; i++) expect(Object.hasOwn(saved.models, names[i])).toBe(true);
  });

  it('separates same-origin routes only through explicit non-sensitive grouping keys', () => {
    const file = mappingFile();
    const aliases = { 'https://private-host.invalid/private-route-a?credential=sentinel-a': 'group-a',
      'https://private-host.invalid/private-route-b?credential=sentinel-b': 'group-b' };
    const identities = new ObservationIdentities(file, undefined, aliases);
    const [first, second] = Object.keys(aliases).map((url) => identities.provider(url));
    expect(first).not.toBe(second);
    expect(new ObservationIdentities(file, undefined, aliases).provider(Object.keys(aliases)[0])).toBe(first);
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toMatch(/private-route|credential|sentinel/);
  });
  it('normalizes origins, keeps credentials/routes out of the mapping, and survives reloading', () => {
    const file = mappingFile();
    const first = new ObservationIdentities(file);
    const p = first.provider('https://private-user:private-password@EXAMPLE.com:443/private-path?secret=private-query#private-fragment');
    const m = first.model('private-model-name');
    expect(first.provider('https://example.com/other-route')).toBe(p);
    expect(first.provider('https://example.com:8443/other-route')).not.toBe(p);
    expect(first.model('another-model')).not.toBe(m);
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toMatch(/private-user|private-password|private-path|private-query|private-fragment/);
    expect(p).not.toContain('example'); expect(m).not.toContain('private');
    const restored = new ObservationIdentities(file);
    expect(restored.provider('https://example.com/v1')).toBe(p);
    expect(restored.model('private-model-name')).toBe(m);
    const aliasA = new ObservationIdentities(file, () => 'route-a');
    const a = aliasA.provider('https://example.com/v1');
    const aliasB = new ObservationIdentities(file, () => 'route-b');
    const b = aliasB.provider('https://example.com/v1');
    expect(new Set([p, a, b]).size).toBe(3);
    expect(new ObservationIdentities(file, () => 'route-b').provider('https://example.com/anything')).toBe(b);
  });

  it('does not use encrypted keys or key masks to determine provider or model identity', () => {
    const file = mappingFile();
    const collector = new RoomObservability({ sink: { emit: () => {} }, mappingPath: file });
    const seat = { baseUrl: 'https://example.com/v1', model: 'model', apiProtocol: 'responses', apiKeyEnc: 'private-key-one', apiKeyMask: 'private-mask-one' } as SeatRecord;
    const first = collector.provider(seat);
    expect(collector.provider({ ...seat, apiKeyEnc: 'private-key-two', apiKeyMask: 'private-mask-two' })).toEqual(first);
    expect(readFileSync(file, 'utf8')).not.toMatch(/private-key|private-mask/);
    collector.finish();
  });

  it('preserves identities written by another already-open mapping instance', () => {
    const file = mappingFile();
    const a = new ObservationIdentities(file);
    const b = new ObservationIdentities(file);
    const provider = a.provider('https://a.example/v1');
    const model = b.model('model-b');
    const restored = new ObservationIdentities(file);
    expect(restored.provider('https://a.example/v1')).toBe(provider);
    expect(restored.model('model-b')).toBe(model);
  });
});
