import { SpeechCursor, type SpeechItem } from './speech';
import type { SpeechOutput } from './speech-output';
import type { Projection, RoomBrief, ViewResponse } from '@werewolf/protocol';

interface Entry { item: SpeechItem; manual: boolean; failed: boolean; error: string }
export interface PlaybackState {
  enabled: boolean; paused: boolean; current: SpeechItem | null; queued: number;
  loading: boolean; error: string; failed: boolean; yielding: boolean; overriding: boolean;
}
export interface DecisionWindow { id: string; availableAt?: number }
export function humanDecisionWindow(room: RoomBrief | undefined, projection: Projection | null, presentation?: ViewResponse['presentation']): DecisionWindow | null {
  if (room?.viewer !== 'seat' || room.status !== 'running' || room.paused ||
      !room.seats.some((seat) => seat.seat === room.seat && seat.controller === 'human') ||
      !projection?.task || projection.task.submitted) return null;
  return { id: projection.task.decisionId, availableAt: presentation?.actionAvailableAt };
}

/** 播放队列与驱动分离；所有驱动回调都受代次保护。 */
export class SpeechPlaybackController {
  private cursor = new SpeechCursor();
  private queue: SpeechItem[] = [];
  private current: Entry | null = null;
  private suspended: Entry | null = null;
  private suspendedPaused = false;
  private driver: SpeechOutput | null = null;
  private generation = 0;
  private enabled = false;
  private paused = false;
  private loading = false;
  private error = '';
  private rate = 1;
  private decision: DecisionWindow | null = null;
  private override = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private factory: (() => SpeechOutput) | null = null;

  constructor(private notify: (state: PlaybackState) => void) {}
  snapshot(): PlaybackState {
    return { enabled: this.enabled, paused: this.paused, current: this.current?.item ?? null,
      queued: this.queue.length + (this.suspended ? 1 : 0), loading: this.loading,
      error: this.error, failed: !!this.current?.failed, yielding: this.yielding(), overriding: this.override };
  }
  private emit() { this.notify(this.snapshot()); }
  private yielding() { return !!this.decision && (this.decision.availableAt === undefined || Date.now() >= this.decision.availableAt) && !this.override; }
  private stopDriver() { this.generation++; this.driver?.stop(); this.driver = null; this.loading = false; }
  sync(items: SpeechItem[]) {
    this.queue.push(...this.cursor.sync(items, this.enabled));
    this.pump(); this.emit();
  }
  setSource(factory: (() => SpeechOutput) | null, missingMessage = '') {
    this.stopDriver(); this.factory = factory;
    if (!factory && this.current) { this.current.failed = true; this.current.error = missingMessage || '请先选择可用的朗读来源。'; }
    this.error = this.current?.failed ? this.current.error : missingMessage;
    this.pump(); this.emit();
  }
  setRate(rate: number) { this.rate = rate; this.driver?.setRate(rate); }
  setDecision(decision: DecisionWindow | null) {
    const changed = this.decision?.id !== decision?.id;
    this.decision = decision;
    if (changed) {
      this.override = false;
      if (this.current?.manual) {
        this.stopDriver(); this.current = this.suspended; this.suspended = null;
        this.paused = this.suspendedPaused; this.suspendedPaused = false;
        this.error = this.current?.failed ? this.current.error : '';
      }
    }
    clearTimeout(this.timer);
    if (decision?.availableAt !== undefined && decision.availableAt > Date.now()) {
      this.timer = setTimeout(() => this.reconcileDecision(), Math.min(decision.availableAt - Date.now(), 2147483647));
    }
    this.reconcileDecision();
  }
  private reconcileDecision() {
    if (this.decision?.availableAt !== undefined && this.decision.availableAt > Date.now()) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reconcileDecision(), Math.min(this.decision.availableAt - Date.now(), 2147483647));
    }
    if (this.yielding()) this.stopDriver();
    else this.pump();
    this.emit();
  }
  start(items: SpeechItem[]) {
    if (!this.factory) { this.error = '请先选择可用的朗读来源。'; this.emit(); return; }
    this.cursor.sync(items, false); this.enabled = true; this.paused = false;
    if (!this.current && !this.queue.length && items.length) this.queue.push(items[items.length - 1]);
    this.pump(); this.emit();
  }
  stop() {
    this.stopDriver(); this.enabled = false; this.paused = false; this.current = null;
    this.suspended = null; this.suspendedPaused = false; this.queue = []; this.error = ''; this.override = false; this.emit();
  }
  read(item: SpeechItem) {
    if (!this.factory) { this.error = '请先选择可用的朗读来源。'; this.emit(); return; }
    if (!this.current?.manual) { this.suspended = this.current; this.suspendedPaused = this.paused; }
    this.stopDriver(); this.current = { item, manual: true, failed: false, error: '' };
    this.error = ''; this.paused = false;
    if (this.yielding()) this.override = true;
    this.pump(); this.emit();
  }
  retry() {
    if (!this.current?.failed || !this.factory) return;
    this.current.failed = false; this.current.error = ''; this.error = '';
    this.pump(); this.emit();
  }
  async togglePause() {
    if (!this.paused) { this.paused = true; this.driver?.pause(); this.emit(); return; }
    this.paused = false; this.error = '';
    if (this.driver && !this.yielding()) {
      const own = this.generation;
      try { await this.driver.resume(); } catch {
        if (own === this.generation) { this.paused = true; this.error = '浏览器未能播放，请再次点击继续。'; }
      }
      if (own !== this.generation) return;
    } else this.pump();
    this.emit();
  }
  dispose() { clearTimeout(this.timer); this.stopDriver(); }
  private pump() {
    if (this.driver || this.paused || this.yielding() || !this.factory) return;
    if (!this.current && this.queue.length) this.current = { item: this.queue.shift()!, manual: false, failed: false, error: '' };
    if (!this.current || this.current.failed) return;
    const driver = this.factory(), own = ++this.generation;
    this.driver = driver; this.loading = true; this.error = '';
    const fail = (message: string) => {
      if (own !== this.generation || !this.current) return;
      this.current.failed = true; this.current.error = message; this.error = message;
      this.stopDriver(); this.emit();
    };
    void driver.play(this.current.item, this.rate, {
      ready: () => { if (own === this.generation) { this.loading = false; this.emit(); } },
      ended: () => {
        if (own !== this.generation) return;
        const manual = this.current?.manual, completedSeq = this.current?.item.seq; this.stopDriver();
        if (manual && this.suspended?.item.seq === completedSeq) this.suspended = null;
        if (manual) this.queue = this.queue.filter((item) => item.seq !== completedSeq);
        if (manual) this.override = false;
        this.current = manual ? this.suspended : null; this.suspended = null;
        if (manual) { this.paused = this.suspendedPaused; this.suspendedPaused = false; }
        this.error = this.current?.failed ? this.current.error : '';
        this.pump(); this.emit();
      },
      blocked: (message) => { if (own === this.generation) { this.paused = true; this.loading = false; this.error = message; this.emit(); } },
      failed: fail,
    }).catch((e: Error) => fail(e.message));
  }
}
