import type { GameEvent } from '@werewolf/protocol';
import { describe, expect, it } from 'vitest';
import {
  allOptions,
  allPresets,
  buildRules,
  createGame,
  projectSeat,
  replay,
  submit,
  waitingSeats,
  type ActionRecord,
  type CreateGameOptions,
} from '../src/index';
import { makeRand, randomCall, type Rand } from './random';

const SECRET_TYPES = /^(wolf\.|witch\.|guard\.|seer\.|mirror\.|awakened\.|role\.assigned|action\.)/;
const RULE_REJECTIONS = ['SAME_NIGHT_BOTH_POTIONS'];

function randomValues(r: Rand): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const o of allOptions()) {
    if (!o.editable) continue;
    if (o.type === 'boolean') values[o.key] = r() < 0.5;
    if (o.type === 'choice' && o.choices) values[o.key] = o.choices[Math.floor(r() * o.choices.length)].value;
  }
  return values;
}

function playRandom(options: CreateGameOptions, r: Rand) {
  const first = createGame(options);
  let state = first.state;
  const events: GameEvent[] = [...first.events];
  const actions: ActionRecord[] = [];
  for (let i = 0; i < 20000 && !state.result; i++) {
    const seat = waitingSeats(state)[0];
    expect(seat, '流程卡住：没有待行动座位').toBeDefined();
    const view = projectSeat(state, events, seat);
    expect(view.task?.tools).toEqual(state.pending!.tools[seat]);

    // 偶尔让一名存活狼人用打断工具自爆。
    const exploder =
      r() < 0.02
        ? state.players.find((p) => p.alive && p.role === 'werewolf' && projectSeat(state, events, p.seat).interrupts.some((t) => t.name === 'wolf_explode'))
        : undefined;
    let input: ActionRecord = exploder
      ? { seat: exploder.seat, call: { tool: 'wolf_explode', args: {} } }
      : r() < 0.1
        ? { seat, call: { tool: '', args: {} }, auto: true }
        : { seat, call: randomCall(r, state.pending!.tools[seat]), decisionId: state.pending!.id };
    let res = submit(state, input);
    // 随机参数可能组合出规则不允许的行动（例如同晚既救又毒）：拒绝只发给本人，然后托管。
    if (res.error && RULE_REJECTIONS.includes(res.error.code)) {
      expect(res.events.map((e) => e.audience)).toEqual([[seat]]);
      state = res.state;
      events.push(...res.events);
      actions.push(input);
      input = { seat, call: { tool: '', args: {} }, auto: true };
      res = submit(state, input);
    }
    expect(res.error, JSON.stringify(input)).toBeUndefined();
    state = res.state;
    events.push(...res.events);
    actions.push(input);
  }
  return { state, events, actions };
}

describe('随机整局', () => {
  for (const preset of allPresets()) {
    it(`${preset.name}：多种子随机规则都能打完，公共信息不泄露，可以重放（SYS-04 / SYS-06）`, () => {
      for (let seed = 1; seed <= 30; seed++) {
        const r = makeRand(seed * 7919);
        const rules = buildRules(preset.id, randomValues(r));
        const options: CreateGameOptions = { id: `fuzz-${seed}`, rules, seed: `seed-${seed}` };
        const { state, events, actions } = playRandom(options, r);
        expect(state.result, `${preset.id} 种子 ${seed} 没有结束`).not.toBeNull();

        const endAt = events.findIndex((e) => e.type === 'game.end');
        const publicBeforeEnd = events.slice(0, endAt).filter((e) => e.audience === 'public');
        expect(publicBeforeEnd.filter((e) => SECRET_TYPES.test(e.type))).toEqual([]);
        expect(publicBeforeEnd.filter((e) => /毒|守护|刀口|查验/.test(e.text))).toEqual([]);
        for (const e of events) {
          if (Array.isArray(e.audience)) expect(e.audience.every((s) => s >= 1 && s <= rules.playerCount)).toBe(true);
        }
        expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

        const again = replay(options, actions);
        expect(again.events).toEqual(events);
        expect(again.state.result).toEqual(state.result);
      }
    });
  }
});
