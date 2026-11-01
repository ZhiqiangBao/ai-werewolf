import type { GameEvent } from '@werewolf/protocol';

export interface SpeechItem { seq: number; seat: number; text: string }
export function publicSpeech(events: GameEvent[]): SpeechItem[] {
  return events.flatMap((e) => e.type === 'speech' && e.audience === 'public' && typeof e.payload.content === 'string' && typeof e.payload.seat === 'number'
    ? [{ seq: e.seq, seat: e.payload.seat, text: e.payload.content }] : []);
}

/** 首次同步只定位到当前记录；重连和重复推送都不重读旧发言。 */
export class SpeechCursor {
  private seen = new Set<number>();
  private initialized = false;
  sync(items: SpeechItem[], enabled: boolean): SpeechItem[] {
    const fresh = this.initialized && enabled ? items.filter((item) => !this.seen.has(item.seq)) : [];
    for (const item of items) this.seen.add(item.seq);
    this.initialized = true;
    return fresh;
  }
}
