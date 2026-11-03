import type { GameEvent, Viewer } from '@werewolf/protocol';
import { skillEffectForEvent, type SkillEffect } from '../../../packages/protocol/src/skill-effects';

/** 每个凭证、游戏与视角单独初始化游标；刷新历史不触发动画。 */
export class SkillEffectQueue {
  private scope: string | null = null;
  private cursor = 0;
  private queue: SkillEffect[] = [];

  update(scope: string, viewer: Viewer, events: readonly GameEvent[], seats: readonly number[]): SkillEffect[] {
    const cursor = Math.max(0, ...events.map((e) => e.seq));
    if (this.scope !== scope) {
      this.scope = scope;
      this.cursor = cursor;
      this.queue = [];
      return [];
    }
    if (cursor < this.cursor) {
      this.queue = [];
      return [];
    }
    const authorized = (effect: SkillEffect) => {
      const event = events.find((e) => e.seq === effect.sourceSeq);
      const current = event && skillEffectForEvent(event, viewer, cursor);
      return seats.includes(effect.target) && current?.kind === effect.kind && current.target === effect.target;
    };
    this.queue = this.queue.filter(authorized);
    for (const event of events) {
      if (event.seq <= this.cursor) continue;
      const effect = skillEffectForEvent(event, viewer, cursor);
      if (effect && seats.includes(effect.target)) this.queue.push(effect);
    }
    this.queue.sort((a, b) => a.sourceSeq - b.sourceSeq);
    this.cursor = cursor;
    return [...this.queue];
  }

  complete(scope: string, sourceSeq: number): SkillEffect[] {
    if (scope === this.scope && this.queue[0]?.sourceSeq === sourceSeq) this.queue.shift();
    return scope === this.scope ? [...this.queue] : [];
  }
}

/** 渲染时再次验证，避免 useEffect 清理前显示上一视角或已撤回的事件。 */
export function visibleSkillEffect(effect: SkillEffect | undefined, viewer: Viewer, events: readonly GameEvent[], seats: readonly number[]): SkillEffect | null {
  if (!effect || !seats.includes(effect.target)) return null;
  const event = events.find((e) => e.seq === effect.sourceSeq);
  const current = event && skillEffectForEvent(event, viewer, event.seq);
  return current?.kind === effect.kind && current.target === effect.target ? effect : null;
}
