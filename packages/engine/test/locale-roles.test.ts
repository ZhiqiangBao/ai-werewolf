import { describe, expect, it } from 'vitest';
import { gameRecordEvents } from '@werewolf/protocol';
import { buildRules, createGame, projectGod, projectSeat, projectSpectator, submit, validateRules, waitingSeats } from '../src/index';
import { DEAL12 } from './harness';

const expected = {
  'zh-CN': { guard: '守卫', inspect: '查验结果：1号是狼人。', knife: '狼人今晚选择刀 9号。', save: '你对 9号 使用了解药。', self: '不能选择自己' },
  en: { guard: 'Guard', inspect: 'Inspection result: Player 1 is Werewolf.', knife: 'Wolves chose to attack Player 9 tonight.', save: 'You used antidote on Player 9.', self: 'cannot target yourself' },
  ja: { guard: '騎士', inspect: '占い結果：1番は人狼です。', knife: '今夜、人狼は9番を襲撃先に選びました。', save: '9番に解毒薬を使いました。', self: '自分' },
} as const;

const nightExpected = {
  'zh-CN': {
    guard: '你今晚守护了 10号。', poison: '你对 11号 使用了毒药。',
    good: '查验结果：9号是好人。', wolf: '查验结果：1号是狼人。',
    recordGuard: '守卫（8号）守护10号。', recordPoison: '女巫（6号）对11号使用毒药。',
    recordGood: '预言家（5号）查验9号：好人。', recordWolf: '预言家（5号）查验1号：狼人。',
    historyGuard: '守卫（8号）守护 10号', historyPoison: '女巫（6号）毒 11号',
  },
  en: {
    guard: 'You protected Player 10 tonight.', poison: 'You used poison on Player 11.',
    good: 'Inspection result: Player 9 is Good.', wolf: 'Inspection result: Player 1 is Werewolf.',
    recordGuard: 'Guard (Player 8) protects Player 10.', recordPoison: 'Witch (Player 6) uses poison on Player 11.',
    recordGood: 'Seer (Player 5) inspects Player 9: Good.', recordWolf: 'Seer (Player 5) inspects Player 1: Werewolf.',
    historyGuard: 'Guard (Player 8) protects Player 10', historyPoison: 'Witch (Player 6): Poison Player 11',
  },
  ja: {
    guard: '今夜は10番を護衛しました。', poison: '11番に毒薬を使いました。',
    good: '占い結果：9番は善良です。', wolf: '占い結果：1番は人狼です。',
    recordGuard: '騎士（8番）が10番を護衛。', recordPoison: '魔女（6番）が11番に毒薬を使用。',
    recordGood: '占い師（5番）が9番を占い：善良。', recordWolf: '占い師（5番）が1番を占い：人狼。',
    historyGuard: '騎士（8番）が10番を護衛', historyPoison: '魔女（6番）：11番に毒を使う',
  },
} as const;

describe.each(['zh-CN', 'en', 'ja'] as const)('角色语言与私密投影 %s', (locale) => {
  it.each([[9, 'good'], [1, 'wolf']] as const)('守卫守护、预言家查验 %s 和女巫用毒的结算与复盘', (target, result) => {
    const rules = buildRules('standard12', {}, { locale, toolsetVersion: 2 });
    let { state, events } = createGame({ id: 'locale-night', seed: 'fixed', rules, deal: DEAL12 });
    const submitCall = (seat: number, tool: string, args: Record<string, unknown>) => {
      const outcome = submit(state, { seat, call: { tool, args } });
      expect(outcome.error).toBeUndefined(); state = outcome.state; events.push(...outcome.events);
      return outcome;
    };
    const advance = (step: string) => {
      for (let i = 0; i < 60 && state.pending?.step.type !== step; i++) {
        const seat = waitingSeats(state)[0], tools = state.pending!.tools[seat];
        const outcome = tools.some((t) => t.name === 'wolf_kill')
          ? submit(state, { seat, call: { tool: 'wolf_kill', args: { targetSeat: 9 } } })
          : submit(state, { seat, call: { tool: '', args: {} }, auto: true });
        expect(outcome.error).toBeUndefined(); state = outcome.state; events.push(...outcome.events);
      }
      expect(state.pending?.step.type).toBe(step);
    };
    advance('night:guard');
    const guardTool = projectSeat(state, events, 8).task!.tools.find((tool) => tool.name === 'guard_protect')!;
    expect(guardTool.params[0]).toMatchObject({ kind: 'seat', name: 'targetSeat', options: expect.arrayContaining([10]) });
    const guardSubmission = submitCall(8, 'guard_protect', { targetSeat: 10 });
    // 守卫是单人决策，提交即结算，不产生等待中的 submittedText；私密事件是确认回执。
    expect(guardSubmission.events.find((event) => event.type === 'guard.protect')).toMatchObject({ audience: [8], payload: { target: 10 }, text: nightExpected[locale].guard });
    expect(state.night!.protections).toEqual(expect.arrayContaining([expect.objectContaining({ target: 10, kind: 'guard', by: 8 })]));

    advance('night:seer');
    const seerTool = projectSeat(state, events, 5).task!.tools.find((tool) => tool.name === 'seer_inspect')!;
    expect(seerTool.params[0]).toMatchObject({ kind: 'seat', name: 'targetSeat', options: expect.arrayContaining([target]) });
    const seerSubmission = submitCall(5, 'seer_inspect', { targetSeat: target });
    expect(seerSubmission.events.find((event) => event.type === 'seer.result')).toMatchObject({ audience: [5], payload: { target, result }, text: nightExpected[locale][result] });
    expect(projectSeat(state, events, 5).me!.knownIdentities).toContainEqual(expect.objectContaining({ seat: target, alignment: result, source: 'inspection' }));

    advance('night:witch');
    const poisonTool = projectSeat(state, events, 6).task!.tools.find((tool) => tool.name === 'witch_poison')!;
    expect(poisonTool.params[0]).toMatchObject({ kind: 'seat', name: 'targetSeat', options: expect.arrayContaining([11]) });
    const poisonSubmission = submitCall(6, 'witch_poison', { targetSeat: 11 });
    expect(poisonSubmission.events.find((event) => event.type === 'witch.poison')).toMatchObject({ audience: [6], payload: { target: 11 }, text: nightExpected[locale].poison });
    const resolution = events.find((event) => event.type === 'night.resolution')!;
    expect(resolution.payload.deaths).toEqual([{ seat: 9, causes: ['wolf'] }, { seat: 11, causes: ['poison'] }]);
    expect(state.history.nights[0].deaths).toEqual([9, 11]);
    expect(state.history.nights[0].lines).toEqual(expect.arrayContaining([nightExpected[locale].historyGuard, nightExpected[locale].historyPoison]));

    const privateEvents = ['guard.protect', 'seer.result', 'witch.poison'];
    for (let seat = 1; seat <= 12; seat++) {
      const visible = projectSeat(state, events, seat).events.filter((event) => privateEvents.includes(event.type));
      const expectedType = seat === 8 ? 'guard.protect' : seat === 5 ? 'seer.result' : seat === 6 ? 'witch.poison' : undefined;
      expect(visible.map((event) => event.type)).toEqual(expectedType ? [expectedType] : []);
    }
    expect(projectSpectator(state, events).events.some((event) => privateEvents.includes(event.type))).toBe(false);
    const recording = gameRecordEvents(projectGod(state, events).events, locale);
    expect(recording.find((event) => event.type === 'guard.protect')?.text).toBe(nightExpected[locale].recordGuard);
    expect(recording.find((event) => event.type === 'seer.result')?.text).toBe(result === 'good' ? nightExpected[locale].recordGood : nightExpected[locale].recordWolf);
    expect(recording.find((event) => event.type === 'witch.poison')?.text).toBe(nightExpected[locale].recordPoison);
    expect(gameRecordEvents(projectSpectator(state, events).events, locale).some((event) => privateEvents.includes(event.type))).toBe(false);
  });
  it('守卫、预言家和女巫按房间语言获得提示、错误和结果，其他人看不到私密事件', () => {
    const rules = buildRules('standard12', {}, { locale, toolsetVersion: 2 });
    let { state, events } = createGame({ id: 'locale-roles', seed: 'fixed', rules, deal: DEAL12 });
    const act = (seat: number, tool: string, args: Record<string, unknown> = {}) => {
      const r = submit(state, { seat, call: { tool, args } });
      state = r.state; events.push(...r.events); return r.error;
    };
    const advance = (step: string) => {
      for (let i = 0; i < 60 && state.pending?.step.type !== step; i++) {
        const seat = waitingSeats(state)[0];
        const tools = state.pending!.tools[seat];
        const r = tools.some((t) => t.name === 'wolf_kill')
          ? submit(state, { seat, call: { tool: 'wolf_kill', args: { targetSeat: 9 } } })
          : submit(state, { seat, call: { tool: '', args: {} }, auto: true });
        expect(r.error).toBeUndefined(); state = r.state; events.push(...r.events);
      }
      expect(state.pending?.step.type).toBe(step);
    };
    advance('night:guard');
    expect(projectSeat(state, events, 8).task!.title).toContain(expected[locale].guard);
    expect(projectSeat(state, events, 8).task!.tools.find((t) => t.name === 'guard_protect')!.params[0]).toMatchObject({ name: 'targetSeat', options: expect.arrayContaining([9]) });
    expect(act(8, 'guard_protect', { targetSeat: 99 })?.code).toBe('TARGET_NOT_IN_GAME');
    expect(act(8, 'guard_protect', { targetSeat: 10 })).toBeUndefined();
    advance('night:seer');
    const error = act(5, 'seer_inspect', { targetSeat: 5 });
    expect(error?.code).toBe('TARGET_SELF_FORBIDDEN');
    expect(error?.reason.toLowerCase()).toContain(expected[locale].self.toLowerCase());
    expect(act(5, 'seer_inspect', { targetSeat: 1 })).toBeUndefined();
    expect(projectSeat(state, events, 5).events.find((e) => e.type === 'seer.result')?.text).toBe(expected[locale].inspect);
    advance('night:witch');
    expect(projectSeat(state, events, 6).task!.prompt).toContain(expected[locale].knife);
    expect(act(6, 'witch_poison', { targetSeat: 6 })?.code).toBe('TARGET_SELF_FORBIDDEN');
    expect(act(6, 'witch_save')).toBeUndefined();
    expect(projectSeat(state, events, 6).events.find((e) => e.type === 'witch.save')?.text).toBe(expected[locale].save);
    const privateTypes = ['guard.protect', 'seer.result', 'witch.knife', 'witch.save'];
    expect(projectSpectator(state, events).events.some((e) => privateTypes.includes(e.type))).toBe(false);
    expect(projectSeat(state, events, 9).events.some((e) => privateTypes.includes(e.type))).toBe(false);
    expect(projectGod(state, events).events.filter((e) => privateTypes.includes(e.type))).toHaveLength(4);
  });
});

it('旧房间缺少语言时回退中文且保留历史事件文本', () => {
  const rules = buildRules('standard12');
  const { state, events } = createGame({ id: 'old-room', seed: 'old', rules, deal: DEAL12 });
  delete state.rules.locale;
  const original = '历史事件原样保留 {0}';
  events.push({ seq: state.seq + 1, day: 1, phase: 'night', type: 'legacy', audience: 'public', text: original, payload: {} });
  const projection = projectSeat(state, events, 5);
  expect(projection.locale).toBe('zh-CN');
  expect(projection.events.find((e) => e.type === 'legacy')?.text).toBe(original);
});

it('规则校验可按界面语言呈现，不改变房间规则', () => {
  const rules = buildRules('standard12', {}, { locale: 'zh-CN' });
  rules.playerCount = 3;
  expect(validateRules(rules, 'en')).toContain('The player count must be between 4 and 20');
  expect(validateRules(rules, 'ja')).toContain('人数は 4〜20 人にしてください');
  expect(rules.locale).toBe('zh-CN');
});
