/** Isolated scheduling model. This is not wired to production runtime or persistence. */
export type Job = Readonly<{ seat: string; from: number; through: number; cue: string; window: string; generation: number; kind: 'listen' | 'action'; projection: string }>;
export type Result = { job: Job; status: 'succeeded' | 'terminal_failed' | 'expired' | 'cancelled' };
type Entry = { job: Job; resolve: (result: Result) => void };

export class PassiveQueue {
  private readonly queues = new Map<string, Entry[]>();
  private readonly running = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private generation = 0;
  private paused = false;
  readonly results: Result[] = [];

  constructor(private readonly execute: (job: Job, signal: AbortSignal) => Promise<unknown>, private readonly validWindow: (job: Job) => boolean, private readonly markAsked: (job: Job) => void, private readonly commit: (job: Job, value: unknown) => void = () => {}) {}
  currentGeneration(): number { return this.generation; }
  size(seat: string): number { return (this.queues.get(seat)?.length ?? 0) + Number(this.running.has(seat)); }
  enqueue(input: Job): Promise<Result> {
    if (this.paused || input.generation !== this.generation) throw new Error('paused or stale generation');
    if (this.size(input.seat) >= 32) throw new Error('high water');
    const job = Object.freeze({ ...input });
    if (job.kind === 'action' && !this.validWindow(job)) {
      const result: Result = { job, status: 'expired' }; this.results.push(result); return Promise.resolve(result);
    }
    return new Promise(resolve => {
      const queue = this.queues.get(job.seat) ?? [];
      queue.push({ job, resolve }); this.queues.set(job.seat, queue); this.pump(job.seat);
    });
  }
  pause(): void {
    this.paused = true; this.generation++;
    for (const controller of this.controllers.values()) controller.abort();
    for (const queue of this.queues.values()) for (const entry of queue.splice(0)) entry.resolve({ job: entry.job, status: 'cancelled' });
  }
  resume(): void { this.paused = false; for (const seat of this.queues.keys()) this.pump(seat); }
  private pump(seat: string): void {
    if (this.paused || this.running.has(seat)) return;
    const entry = this.queues.get(seat)?.shift(); if (!entry) return;
    this.running.add(seat); const controller = new AbortController(); this.controllers.set(seat, controller);
    void (async () => {
      let status: Result['status'];
      try {
        if (entry.job.kind === 'action' && !this.validWindow(entry.job)) status = 'expired';
        else {
          if (entry.job.kind === 'action') this.markAsked(entry.job);
          const value = await this.execute(entry.job, controller.signal);
          status = entry.job.generation !== this.generation ? 'cancelled' : entry.job.kind === 'action' && !this.validWindow(entry.job) ? 'expired' : 'succeeded';
          if (status === 'succeeded') this.commit(entry.job, value);
        }
      } catch { status = entry.job.generation !== this.generation ? 'cancelled' : 'terminal_failed'; }
      const result = { job: entry.job, status };
      if (status !== 'cancelled') this.results.push(result);
      entry.resolve(result); this.controllers.delete(seat); this.running.delete(seat); this.pump(seat);
    })();
  }
}
