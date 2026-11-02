import type { AdapterObservationEvent, DecideObservationPort, Measurement, ObservationFields, ObservationOutcome } from '@werewolf/protocol';

type Kind = AdapterObservationEvent['kind'];
export const measured = (valueMs: number): Measurement => ({ valueMs: Math.max(0, valueMs), source: 'client' });
export const missing = (reason: 'not_observable' | 'not_applicable' | 'not_emitted' | 'cancelled_before_point' | 'failed_before_point'): Measurement => ({ valueMs: null, reason });

/** All observer and clock failures are isolated from the request being measured. */
export class AdapterObserver {
  private nextId = 0;
  requestsStarted = 0;
  attemptsStarted = 0;
  attemptsFinished = 0;
  constructor(private readonly port: DecideObservationPort) {}
  now(): number { try { return this.port.clock.monotonicMs(); } catch { return performance.now(); } }
  emit(event: AdapterObservationEvent): void { try { this.port.emit(event); } catch { /* telemetry is a side channel */ } }
  start(kind: Kind, parentId: string, fields: ObservationFields & { requestId?: string; httpAttemptId?: string } = {}): ObservationSpan {
    if (kind === 'http_request') this.requestsStarted++;
    if (kind === 'http_attempt') this.attemptsStarted++;
    const id = `${this.port.callId}:${++this.nextId}`;
    const atMs = this.now();
    const identified = { ...fields, ...(kind === 'http_request' ? { requestId: id } : {}), ...(kind === 'http_attempt' ? { httpAttemptId: id } : {}) };
    const span = new ObservationSpan(this, kind, id, parentId, atMs, identified);
    this.emit({ kind, phase: 'start', id, parentId, atMs, ...identified });
    return span;
  }
  get callId(): string { return this.port.callId; }
}

export class ObservationSpan {
  private finished = false;
  constructor(readonly observer: AdapterObserver, readonly kind: Kind, readonly id: string, readonly parentId: string,
    readonly started: number, readonly fields: ObservationFields & { requestId?: string; httpAttemptId?: string }) {}
  finish(outcome: ObservationOutcome, fields: ObservationFields & { requestId?: string; httpAttemptId?: string } = {}): void {
    if (this.finished) return;
    this.finished = true;
    if (this.kind === 'http_attempt') this.observer.attemptsFinished++;
    const atMs = this.observer.now();
    this.observer.emit({ kind: this.kind, phase: 'end', id: this.id, parentId: this.parentId, atMs,
      durationMs: measured(atMs - this.started), outcome, ...this.fields, ...fields });
  }
}

/** Measure synchronous work at its existing execution point. */
export function observeSync<T>(observer: AdapterObserver | undefined, parent: ObservationSpan | undefined,
  operation: 'request_encode' | 'parse', work: () => T): T {
  if (!observer || !parent) return work();
  const span = observer.start('local_span', parent.id, { operation, ...(parent.kind === 'http_request' ? { requestId: parent.id } : {}) });
  try { const result = work(); span.finish('success', { metrics: { [operation === 'parse' ? 'parseMs' : 'requestEncodeMs']: measured(observer.now() - span.started) } }); return result; }
  catch (error) { span.finish(operation === 'parse' ? 'parse_error' : 'local_error', { metrics: { [operation === 'parse' ? 'parseMs' : 'requestEncodeMs']: measured(observer.now() - span.started) } }); throw error; }
}
