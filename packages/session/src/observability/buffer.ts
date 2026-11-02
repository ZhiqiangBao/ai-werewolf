import { performance } from 'node:perf_hooks';
import type { ObservationEvent, ObservationSink } from '@werewolf/protocol';

export interface BufferedSinkOptions {
  write(events: readonly ObservationEvent[]): Promise<void>;
  maxRecords?: number;
  maxBytes?: number;
  flushMs?: number;
  batchSize?: number;
}

/** 待写批次仍占用配额；只允许一个写任务，不积累无界后台 Promise。 */
export class BufferedObservationSink implements ObservationSink {
  readonly config: Required<Omit<BufferedSinkOptions, 'write'>>;
  readonly stats = { bufferedRecords: 0, bufferedBytes: 0, peakRecords: 0, peakBytes: 0,
    dropped: 0, writeErrors: 0, writtenRecords: 0, writtenBytes: 0, writeMs: 0 };
  private queue: { event: ObservationEvent; bytes: number }[] = [];
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: BufferedSinkOptions) {
    this.config = { maxRecords: options.maxRecords ?? 10_000, maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
      flushMs: options.flushMs ?? 100, batchSize: options.batchSize ?? 256 };
    if (Object.values(this.config).some((n) => !Number.isFinite(n) || n <= 0)) throw new Error('观测缓冲配置必须为正数');
  }

  emit(event: ObservationEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (this.closed || this.stats.bufferedRecords >= this.config.maxRecords || this.stats.bufferedBytes + bytes > this.config.maxBytes) {
      this.stats.dropped++; return;
    }
    this.queue.push({ event, bytes });
    this.stats.bufferedRecords++;
    this.stats.bufferedBytes += bytes;
    this.stats.peakRecords = Math.max(this.stats.peakRecords, this.stats.bufferedRecords);
    this.stats.peakBytes = Math.max(this.stats.peakBytes, this.stats.bufferedBytes);
    if (this.timer && this.queue.length >= this.config.batchSize) { clearTimeout(this.timer); this.timer = null; }
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.queue.length >= this.config.batchSize ? 0 : this.config.flushMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.writing) { await this.writing; if (this.queue.length) await this.flush(); return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.config.batchSize);
    const bytes = batch.reduce((n, row) => n + row.bytes, 0);
    this.writing = (async () => {
      const started = performance.now();
      try {
        await this.options.write(batch.map((row) => row.event));
        this.stats.writtenRecords += batch.length;
        this.stats.writtenBytes += bytes;
      } catch {
        this.stats.writeErrors++;
        this.stats.dropped += batch.length;
      } finally {
        this.stats.writeMs += performance.now() - started;
        this.stats.bufferedRecords -= batch.length;
        this.stats.bufferedBytes -= bytes;
      }
    })();
    await this.writing;
    this.writing = null;
    if (this.queue.length) await this.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
