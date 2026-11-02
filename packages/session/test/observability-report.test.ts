import { describe, expect, it } from 'vitest';
import type { AuditEntry, ObservationEvent } from '@werewolf/protocol';
import { buildObservationReport, distribution, legacyAuditObservations } from '../src/observability/report';

const ms = (valueMs: number) => ({ valueMs, source: 'client' as const });
const common = { schemaVersion: 1 as const, runId: 'run', roomRef: 'room', kind: 'model_call' as const,
  providerId: 'provider', modelKey: 'model', apiProtocol: 'responses' as const, purpose: 'action' as const };
const call = (id: string, phase: 'start' | 'end', more: Partial<ObservationEvent> = {}): ObservationEvent =>
  ({ ...common, id, callId: id, phase, atMs: 0, ...more } as ObservationEvent);

describe('offline observability report', () => {
  it('uses nearest-rank and preserves missing reasons', () => {
    expect(distribution([ms(9), ms(1), ms(3), { valueMs: null, reason: 'legacy' }, undefined])).toMatchObject({
      count: 3, missing: 2, p50: 3, p90: 9, p95: 9, max: 9, smallSample: true,
      missingReasons: { legacy: 1, not_emitted: 1 },
    });
    expect(distribution([])).toMatchObject({ count: 0, p50: null, p95: null });
  });

  it('deduplicates spans and usage, counts cancellations, incomplete and separates elapsed time', () => {
    const usage = { inputTokens: 10, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: null, completeness: 'partial' as const, sourceHttpAttemptId: 'http1' };
    const events: ObservationEvent[] = [
      call('one', 'start'), call('one', 'end', { outcome: 'success', durationMs: ms(100), usage }),
      call('one', 'end', { outcome: 'success', durationMs: ms(100), usage }),
      call('two', 'start'), call('two', 'end', { outcome: 'cancelled', durationMs: ms(200) }), call('three', 'start'),
      { ...common, kind: 'http_attempt', id: 'http1', httpAttemptId: 'http1', callId: 'one', phase: 'start', atMs: 0 },
      { ...common, kind: 'http_attempt', id: 'http1', httpAttemptId: 'http1', callId: 'one', phase: 'end', atMs: 0, durationMs: ms(90), usage },
      { ...common, kind: 'room', id: 'room', phase: 'start', atMs: 0 },
      { ...common, kind: 'room', id: 'room', phase: 'end', atMs: 0, durationMs: ms(210) },
    ];
    const report = buildObservationReport(events);
    expect(report.layers.model_call).toMatchObject({ started: 3, finished: 2, incomplete: 1, outcomes: { success: 1, cancelled: 1 }, successRate: 0.5 });
    expect(report.duplicates).toBe(1);
    expect(report.sumModelCallMs).toBe(300);
    expect(report.sumHttpAttemptMs).toBe(90);
    expect(report.measurements.roomWallMs.p50).toBe(210);
    expect(report.measurements.modelCallMs).toMatchObject({ count: 2, missing: 1, missingReasons: { incomplete: 1 } });
    expect(report.groups[0].calls.successRate).toBe(0.5);
    expect(report.usage).toMatchObject({ uniqueSources: 1, duplicateSources: 1, callsWithUsage: 1, callsWithoutUsage: 2,
      fields: { inputTokens: { total: 10, known: 1, eligible: 1, coverage: 1 }, outputTokens: { total: null, known: 0, missing: 1, coverage: 0 }, cacheReadTokens: { total: 0, known: 1 } } });
  });

  it('does not infer unknown legacy dimensions or copy audit payloads and avoids linked duplicates', () => {
    const rows = [{ id: 1, at: 1, seat: 1, model: 'private-name', decisionId: 'private', projectionVersion: 1, ok: false,
      messages: ['secret'], observation: { schemaVersion: 1, runId: 'run', roomRef: 'room', callId: 'one' } },
    { id: 2, at: 2, seat: 1, model: 'private-name', decisionId: 'private', projectionVersion: 1, ok: true, latencyMs: 42 }] as AuditEntry[];
    const events = legacyAuditObservations(rows, 'room', [call('one', 'start')]);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/private|secret/);
    const report = buildObservationReport(events);
    expect(report.groups[0]).toMatchObject({ providerId: 'unknown', modelKey: 'unknown', apiProtocol: 'unknown', purpose: 'unknown' });
    expect(report.measurements.modelCallMs.missingReasons).toEqual({ legacy: 1 });
    expect(report.measurements.legacyLatencyMs.p50).toBe(42);
    expect(report.sumModelCallMs).toBeNull();
  });

  it('does not mistake an unknown snapshot with an attempt ID for known usage', () => {
    const report = buildObservationReport([call('one', 'start'), call('one', 'end', { outcome: 'cancelled', usage: {
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      completeness: 'unknown', sourceHttpAttemptId: 'http1',
    } })]);
    expect(report.usage).toMatchObject({ uniqueSources: 0, callsWithUsage: 0, callsWithoutUsage: 1 });
  });

  it('counts an explicit incomplete terminal as incomplete and does not invent final duration', () => {
    const report = buildObservationReport([call('one', 'start'), call('one', 'end', { outcome: 'incomplete', durationMs: ms(4) })]);
    expect(report.layers.model_call).toMatchObject({ started: 1, finished: 0, incomplete: 1, successRate: null });
    expect(report.measurements.modelCallMs).toMatchObject({ count: 0, missingReasons: { incomplete: 1 } });
  });

  it('attributes local measurements to their actual operations without mixing adapter and HTTP parsing', () => {
    const span = (id: string, phase: 'start' | 'end', operation: 'serialize' | 'parse', metrics = {}) =>
      ({ ...common, kind: 'local_span', id, callId: 'one', phase, atMs: 0, operation, metrics } as ObservationEvent);
    const report = buildObservationReport([call('one', 'start'), call('one', 'end', { outcome: 'success' }),
      span('s', 'start', 'serialize'), span('s', 'end', 'serialize', { serializeMs: ms(3) }),
      span('p', 'start', 'parse'), span('p', 'end', 'parse', { parseMs: ms(2) })]);
    expect(report.measurements.serializeMs).toMatchObject({ count: 1, missing: 0, p50: 3 });
    expect(report.measurements.adapterParseMs).toMatchObject({ count: 1, missing: 0, p50: 2 });
  });

  it('accepts queue truth only from the explicit synthetic capacity contract', () => {
    const events = [call('one', 'start'), call('one', 'end', { outcome: 'success' }),
      { ...common, kind: 'http_attempt', id: 'h', callId: 'one', phase: 'start', atMs: 0 },
      { ...common, kind: 'http_attempt', id: 'h', callId: 'one', phase: 'end', atMs: 1, outcome: 'success', metrics: { providerQueueMs: ms(99) } }] as ObservationEvent[];
    expect(buildObservationReport(events).measurements.providerQueueMs).toMatchObject({ count: 0, missingReasons: { not_observable: 1 } });
    const truth = { attemptId: 'h', source: 'synthetic' as const, planned: { headersMs: 20, firstContentMs: 30, chunks: 4, chunkIntervalMs: 10, status: 200, capacity: 1 }, queueMs: 7, headersMs: 20, firstBodyByteMs: 50, firstStreamContentMs: 50, bodyConsumeMs: 60, elapsedMs: 80, finished: true };
    expect(buildObservationReport(events, { syntheticTruth: [truth] }).measurements.providerQueueMs).toMatchObject({ count: 1, p50: 7 });
    expect(buildObservationReport(events, { syntheticTruth: [{ ...truth, planned: { ...truth.planned, capacity: null } }] }).measurements.providerQueueMs.count).toBe(0);
  });
});
