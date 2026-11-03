import { describe, expect, it } from 'vitest';
import { skillEffectForEvent, skillEffectFrame, SKILL_EFFECT_DURATION_MS, type SkillEffectKind } from '../src/skill-effects';
import type { GameEvent, Viewer } from '../src/index';

const event = (type: string, payload: Record<string, unknown>, audience: GameEvent['audience'] = [2]): GameEvent => ({ seq: 8, day: 1, phase: 'night', type, audience, payload, text: '' });
const seat: Viewer = { kind: 'seat', seat: 2 };
const spectator: Viewer = { kind: 'spectator' };
const god: Viewer = { kind: 'god' };

describe('skill animation authorization', () => {
  it('uses only explicit actions visible to the viewer and at or before the playback cursor', () => {
    const poison = event('witch.poison', { target: 4 });
    expect(skillEffectForEvent(poison, seat, 8)).toEqual({ kind: 'poison', target: 4, sourceSeq: 8 });
    expect(skillEffectForEvent(poison, { kind: 'seat', seat: 3 }, 8)).toBeNull();
    expect(skillEffectForEvent(poison, spectator, 8)).toBeNull();
    expect(skillEffectForEvent(poison, god, 7)).toBeNull();
    expect(skillEffectForEvent(poison, god, Number.NaN)).toBeNull();
    expect(skillEffectForEvent(poison, god, 8)?.kind).toBe('poison');
  });
  it('never infers night abilities from public death, hints, or empty choices', () => {
    expect(skillEffectForEvent(event('death', { target: 4, causes: ['poison', 'wolf'] }, 'public'), spectator, 8)).toBeNull();
    expect(skillEffectForEvent(event('witch.knife', { knife: 4 }), seat, 8)).toBeNull();
    expect(skillEffectForEvent(event('wolf.kill.result', { knife: null }), seat, 8)).toBeNull();
    expect(skillEffectForEvent(event('seer.result', { target: '4' }), seat, 8)).toBeNull();
    expect(skillEffectForEvent(event('guard.protect', { target: 0 }), seat, 8)).toBeNull();
  });
  it('maps actual action types including copied abilities and public hunter shot', () => {
    const cases: [GameEvent, SkillEffectKind][] = [
      [event('hunter.shot', { target: 4 }, 'public'), 'shot'],
      [event('seer.result', { target: 4, result: 'wolf' }), 'inspect'],
      [event('mirror.result', { target: 4, role: 'witch' }), 'inspect'],
      [event('guard.protect', { target: 4 }), 'guard'],
      [event('wolf.kill.result', { knife: 4 }), 'wolf'],
      [event('awakened.knife', { target: 4 }), 'wolf'],
      [event('awakened.skill', { target: 4, tool: 'awakened_poison' }), 'poison'],
      [event('awakened.skill', { target: 4, tool: 'awakened_guard' }), 'guard'],
      [event('awakened.skill', { target: 4, tool: 'awakened_claw' }), 'wolf'],
    ];
    for (const [e, kind] of cases) expect(skillEffectForEvent(e, god, 8)).toMatchObject({ kind, target: 4 });
    expect(skillEffectForEvent(cases[0][0], spectator, 8)?.kind).toBe('shot');
    expect(skillEffectForEvent(event('awakened.skill', { target: 4, tool: 'unknown' }), god, 8)).toBeNull();
  });
  it.each(['mirror.result', 'awakened.knife'])('%s respects private audience, cursor and actual target', (type) => {
    const action = event(type, { target: 4 });
    expect(skillEffectForEvent(action, seat, 8)?.target).toBe(4);
    expect(skillEffectForEvent(action, spectator, 8)).toBeNull();
    expect(skillEffectForEvent(action, { kind: 'seat', seat: 3 }, 8)).toBeNull();
    expect(skillEffectForEvent(action, god, 7)).toBeNull();
    expect(skillEffectForEvent(event(type, { target: null }), god, 8)).toBeNull();
  });
  it.each<[string, Record<string, unknown>, SkillEffectKind]>([
    ['witch.poison', { target: 4 }, 'poison'], ['hunter.shot', { target: 4 }, 'shot'],
    ['seer.result', { target: 4, result: 'good' }, 'inspect'], ['guard.protect', { target: 4 }, 'guard'],
    ['wolf.kill.result', { knife: 4 }, 'wolf'],
  ])('%s never reveals an unauthorized or future action', (type, payload, kind) => {
    const action = event(type, payload);
    expect(skillEffectForEvent(action, seat, 8)).toMatchObject({ kind, target: 4 });
    expect(skillEffectForEvent(action, god, 8)).toMatchObject({ kind, target: 4 });
    expect(skillEffectForEvent(action, god, 7)).toBeNull();
    expect(skillEffectForEvent(action, spectator, 8)).toBeNull();
    expect(skillEffectForEvent(action, { kind: 'seat', seat: 3 }, 8)).toBeNull();
  });
});

describe('shared animation frames', () => {
  it.each<SkillEffectKind>(['poison', 'shot', 'inspect', 'guard', 'wolf'])('%s changes over time and stops', (kind) => {
    expect(skillEffectFrame(kind, 300).length).toBeGreaterThan(1);
    expect(skillEffectFrame(kind, 300)).not.toEqual(skillEffectFrame(kind, 900));
    expect(skillEffectFrame(kind, -1)).toEqual([]);
    expect(skillEffectFrame(kind, SKILL_EFFECT_DURATION_MS)).toEqual([]);
  });
});
