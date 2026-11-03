import { describe, expect, it } from 'vitest';
import type { GameEvent, Viewer } from '@werewolf/protocol';
import { SkillEffectQueue, visibleSkillEffect } from '../src/skill-effect-queue';

const e = (seq: number, type: string, audience: GameEvent['audience'], payload: Record<string, unknown>): GameEvent => ({ seq, type, audience, payload, text: '', day: 1, phase: 'night' });
const seer: Viewer = { kind: 'seat', seat: 2 };
const spectator: Viewer = { kind: 'spectator' };
const seats = [1, 2, 3, 4];
const historic = e(1, 'witch.poison', [2], { target: 3 });
const inspect = e(2, 'seer.result', [2], { target: 4, result: 'wolf' });
const shot = e(3, 'hunter.shot', 'public', { target: 1 });

describe('live skill effects', () => {
  it('does not replay history, and queues only new authorized actions in event order', () => {
    const q = new SkillEffectQueue();
    expect(q.update('seat', seer, [historic], seats)).toEqual([]);
    expect(q.update('seat', seer, [historic, shot, inspect], seats)).toEqual([
      { kind: 'inspect', target: 4, sourceSeq: 2 }, { kind: 'shot', target: 1, sourceSeq: 3 },
    ]);
    expect(q.update('seat', seer, [historic, inspect, shot], seats)).toHaveLength(2);
    expect(q.complete('seat', 2)).toEqual([{ kind: 'shot', target: 1, sourceSeq: 3 }]);
    expect(q.complete('seat', 2)).toHaveLength(1);
    expect(q.complete('seat', 3)).toEqual([]);
  });
  it('clears pending private effects immediately on credential or perspective change', () => {
    const q = new SkillEffectQueue();
    q.update('god-credential', { kind: 'god' }, [historic], seats);
    const pending = q.update('god-credential', { kind: 'god' }, [historic, inspect, shot], seats);
    expect(visibleSkillEffect(pending[0], spectator, [shot], seats)).toBeNull();
    expect(q.update('watch-credential', spectator, [shot], seats)).toEqual([]);
    expect(q.complete('god-credential', 2)).toEqual([]);
    expect(q.update('watch-credential', spectator, [shot, e(4, 'witch.poison', [2], { target: 3 })], seats)).toEqual([]);
  });
  it('invalidates removed or changed events and resets when history rolls back', () => {
    const q = new SkillEffectQueue();
    q.update('seat', seer, [historic], seats);
    const pending = q.update('seat', seer, [historic, inspect, shot], seats);
    const changed = e(2, 'seer.result', [2], { target: 3 });
    expect(visibleSkillEffect(pending[0], seer, [historic, changed, shot], seats)).toBeNull();
    expect(q.update('seat', seer, [historic, changed, shot], seats)).toEqual([{ kind: 'shot', target: 1, sourceSeq: 3 }]);
    expect(q.update('seat', seer, [historic], seats)).toEqual([]);
    expect(q.update('seat', seer, [historic, inspect], seats)).toEqual([]);
    expect(q.update('seat', seer, [historic, inspect, shot], seats)).toEqual([]);
  });
  it('ignores empty, invalid, unknown-seat, and hidden actions', () => {
    const q = new SkillEffectQueue();
    q.update('watch', spectator, [], seats);
    expect(q.update('watch', spectator, [
      e(1, 'wolf.kill.result', [2], { knife: 3 }), e(2, 'hunter.shot', 'public', { target: 99 }),
      e(3, 'wolf.kill.result', 'public', { knife: null }), e(4, 'death', 'public', { target: 3, causes: ['poison'] }),
    ], seats)).toEqual([]);
  });
});
