import { describe, expect, it } from 'vitest';
import { actionMenu, expandActionTools, exposeAction, toolToJsonSchema, type ToolSpec } from '@werewolf/protocol';
import { buildRules, createGame, replay, seatTools, submit } from '../src/index';
import { DEAL12, TestGame } from './harness';

const noSheriff = { 'sheriff.enabled': false };
const game = (values: Record<string, unknown> = {}) => new TestGame({ deal: DEAL12, toolsetVersion: 2, values });
const names = (tools: ToolSpec[]) => tools.map((t) => t.name);
const domain = (g: TestGame, seat: number, tool: string, args: Record<string, unknown>) => {
  const call = exposeAction({ tool, args }, g.toolsOf(seat));
  g.ok(seat, call.tool, call.args);
};
function atWitch(kill: number | null = 7, values: Record<string, unknown> = {}): TestGame {
  const g = game({ ...noSheriff, ...values });
  g.until((x) => x.pending?.step.type === 'night:witch', (_seat, tools) => tools.some((t) => t.name === 'wolf_kill')
    ? kill === null ? { tool: 'wolf_empty_kill', args: {} } : { tool: 'wolf_kill', args: { targetSeat: kill } }
    : undefined);
  return g;
}
function untilWitch(g: TestGame, kill: number): void {
  g.until((x) => x.pending?.step.type === 'night:witch', (_seat, tools) => tools.some((t) => t.name === 'wolf_kill') ? { tool: 'wolf_kill', args: { targetSeat: kill } } : undefined);
}

describe('显式单动作工具 v2', () => {
  it('新局默认 v2，24 种工具没有布尔开关或可空目标，所有示例可按 Schema 填写', () => {
    expect(buildRules('standard12').toolsetVersion).toBe(2);
    const g = game();
    const tools = new Map(g.state.players.flatMap((p) => seatTools(g.state, p.seat)).map((t) => [t.name, t]));
    expect(tools.size).toBe(24);
    const double = game({ 'witch.bothPotionsSameNight': true });
    expect(new Set(double.state.players.flatMap((p) => seatTools(double.state, p.seat)).map((t) => t.name)).size).toBe(25);
    expect(tools.has('witch_act')).toBe(false);
    expect(tools.has('badge_dispose')).toBe(false);
    expect(tools.has('wolf_explode_decision')).toBe(false);
    const rawVote: ToolSpec = { name: 'vote', title: '投票', description: '测试', params: [{ kind: 'seat', name: 'target', label: '目标', options: [1], nullable: true }] };
    expect(() => expandActionTools([rawVote, { name: 'vote_abstain', title: '自定义冲突', description: '测试', params: [] }], g.state.rules)).toThrow('动作工具名称重复');
    for (const tool of tools.values()) {
      const schema = toolToJsonSchema(tool);
      expect(schema.additionalProperties, tool.name).toBe(false);
      expect(JSON.stringify(schema)).not.toContain('operation');
      expect(tool.params.some((p) => p.kind === 'boolean' || (p.kind === 'seat' && p.nullable)), tool.name).toBe(false);
      const examples = [...tool.description.matchAll(/\{[^{}]*\}/g)].map((m) => JSON.parse(m[0]));
      expect(examples.length, tool.name).toBeGreaterThan(0);
      for (const example of examples) {
        expect(Object.keys(example).sort(), tool.name).toEqual([...schema.required as string[]].sort());
        for (const p of tool.params) {
          if (p.kind === 'seat') expect(Number.isInteger(example[p.name]) && p.options.includes(example[p.name]), tool.name).toBe(true);
          if (p.kind === 'choice') expect(p.options.map((o) => o.value), tool.name).toContain(example[p.name]);
          if (p.kind === 'text') expect(typeof example[p.name], tool.name).toBe('string');
        }
      }
    }
    const before = JSON.stringify(g.state.players.map((p) => seatTools(g.state, p.seat)));
    g.until((x) => !!x.state.result, (_seat, offered) => {
      for (const t of offered) expect(t.description).toBe(tools.get(t.name)?.description);
      return undefined;
    });
    expect(JSON.stringify(g.state.players.map((p) => seatTools(g.state, p.seat)))).toBe(before);
  });

  it('女巫只救人不填刀口，拒绝混入毒药字段，救人不会消耗毒药', () => {
    const g = atWitch();
    expect(names(g.toolsOf(6))).toEqual(['witch_save', 'witch_poison', 'witch_skip']);
    const before = structuredClone(g.state.players[5].data);
    expect(g.act(6, 'witch_save', { poisonTarget: 7 })?.code).toBe('INVALID_ARGUMENT');
    expect(g.act(6, 'witch_save', { save: false })?.code).toBe('INVALID_ARGUMENT');
    expect(g.state.players[5].data).toEqual(before);
    expect(g.events.some((e) => e.type === 'witch.save' || e.type === 'witch.poison')).toBe(false);
    g.ok(6, 'witch_save');
    expect(g.events.filter((e) => e.type === 'witch.save').at(-1)?.payload.target).toBe(7);
    expect(g.events.some((e) => e.type === 'witch.poison')).toBe(false);
    expect(g.state.players[5].data).toMatchObject({ antidote: false, poison: true });
    g.toNight();
    untilWitch(g, 9);
    expect(names(g.toolsOf(6))).toEqual(['witch_poison', 'witch_skip']);
    expect(actionMenu(g.toolsOf(6))).not.toContain('witch_save');
    expect(g.act(6, 'witch_save')?.code).toBe('TOOL_NOT_LEGAL');
  });

  it('女巫毒人需要真实整数目标，缺失/空值/旧字段均拒绝；仍允许有意毒刀口', () => {
    const g = atWitch();
    for (const args of [{}, { targetSeat: null }, { targetSeat: '7' }, { target: 7 }, { targetSeat: 7, save: true }]) {
      expect(g.act(6, 'witch_poison', args)?.code).toBe('INVALID_ARGUMENT');
      expect(g.state.players[5].data).toMatchObject({ antidote: true, poison: true });
    }
    expect(g.act(6, 'witch_poison', { targetSeat: 6 })?.code).toBe('TARGET_SELF_FORBIDDEN');
    g.ok(6, 'witch_poison', { targetSeat: 7 });
    expect(g.state.players[5].data).toMatchObject({ antidote: true, poison: false });
    expect(g.events.filter((e) => e.type === 'witch.poison').at(-1)?.payload.target).toBe(7);
    expect(g.events.some((e) => e.type === 'witch.save')).toBe(false);
    expect(g.state.deaths.find((d) => d.seat === 7)?.causes).toEqual(['wolf', 'poison']);
    expect(g.hasTool('hunter_shoot')).toBe(false);
    g.toNight();
    untilWitch(g, 9);
    expect(names(g.toolsOf(6))).toEqual(['witch_save', 'witch_skip']);
  });

  it('空刀或禁止自救不提供解药工具；不使用药品保留两瓶药', () => {
    for (const kill of [null, 6]) {
      const g = atWitch(kill);
      expect(names(g.toolsOf(6))).toEqual(['witch_poison', 'witch_skip']);
      expect(g.act(6, 'witch_save')?.code).toBe('TOOL_NOT_LEGAL');
      g.ok(6, 'witch_skip');
      expect(g.state.players[5].data).toMatchObject({ antidote: true, poison: true });
    }
    const self = atWitch(6, { 'witch.selfSave': 'first_night' });
    self.ok(6, 'witch_save');
    expect(self.state.players[5].alive).toBe(true);
  });

  it('同夜双药只有规则允许时才出现，单一明确工具同时消耗两药', () => {
    const normal = atWitch();
    expect(normal.act(6, 'witch_save_and_poison', { targetSeat: 9 })?.code).toBe('TOOL_NOT_LEGAL');
    const g = atWitch(7, { 'witch.bothPotionsSameNight': true });
    expect(names(g.toolsOf(6))).toEqual(['witch_save', 'witch_poison', 'witch_skip', 'witch_save_and_poison']);
    g.ok(6, 'witch_save_and_poison', { targetSeat: 9 });
    expect(g.state.players[5].data).toMatchObject({ antidote: false, poison: false });
    expect(g.state.players[6].alive).toBe(true);
    expect(g.state.players[8].alive).toBe(false);
    expect(replay(g.options, g.actions)).toEqual({ state: g.state, events: g.events });
  });

  it('守护和空守、狼刀和空刀分开，严格拒绝 null 和旧参数', () => {
    const g = game(noSheriff);
    expect(names(g.toolsOf(8))).toEqual(['guard_protect', 'guard_skip']);
    expect(g.act(8, 'guard_protect', { targetSeat: null })?.code).toBe('INVALID_ARGUMENT');
    expect(g.act(8, 'guard_skip', { target: 9 })?.code).toBe('INVALID_ARGUMENT');
    for (const args of [false, null, []]) expect(submit(g.state, { seat: 8, call: { tool: 'guard_skip', args: args as unknown as Record<string, unknown> } }).error?.code).toBe('INVALID_ARGUMENT');
    g.ok(8, 'guard_skip');
    g.untilTool('wolf_kill');
    for (const seat of g.waiting()) {
      expect(names(g.toolsOf(seat))).toEqual(['wolf_kill', 'wolf_empty_kill']);
      expect(g.act(seat, 'wolf_kill', { target: 9 })?.code).toBe('INVALID_ARGUMENT');
      g.ok(seat, 'wolf_empty_kill');
    }
    g.until((x) => x.state.phase === 'day');
    expect(g.events.find((e) => e.type === 'dawn')?.text).toContain('平安');
  });

  it('禁用弃票、空刀时不暴露对应动作；守卫本轮菜单排除上晚目标', () => {
    const g = game({ ...noSheriff, 'vote.allowAbstain': false, 'wolf.allowEmpty': false });
    g.ok(8, 'guard_protect', { targetSeat: 9 });
    g.untilTool('wolf_kill');
    expect(names(g.toolsOf(1))).toEqual(['wolf_kill']);
    expect(g.pending!.prompts[1]).toContain('本局不能选择空刀');
    expect(g.act(1, 'wolf_empty_kill')?.code).toBe('TOOL_NOT_LEGAL');
    g.untilTool('vote');
    expect(names(g.toolsOf(g.waiting()[0]))).toEqual(['vote']);
    for (const seat of g.waiting()) g.ok(seat, 'vote', { targetSeat: seat === 1 ? 2 : 1 });
    g.toNight();
    expect(actionMenu(g.toolsOf(8))).not.toMatch(/可选：[^\n]*\b9\b/);
    expect(g.act(8, 'guard_protect', { targetSeat: 9 })?.code).toBe('INVALID_ARGUMENT');
  });

  it('开枪与放弃开枪分开，放弃不会带走任何人', () => {
    const g = atWitch();
    g.ok(6, 'witch_skip');
    expect(names(g.toolsOf(7))).toEqual(['hunter_shoot', 'hunter_hold_fire']);
    expect(g.act(7, 'hunter_hold_fire', { targetSeat: 9 })?.code).toBe('INVALID_ARGUMENT');
    g.ok(7, 'hunter_hold_fire');
    expect(g.state.history.shots).toHaveLength(0);
    expect(g.state.players[8].alive).toBe(true);
    const shoot = atWitch();
    shoot.ok(6, 'witch_skip');
    shoot.ok(7, 'hunter_shoot', { targetSeat: 9 });
    expect(shoot.state.players[8].alive).toBe(false);
  });

  it('不上警单独提交，当前竞选菜单包含发言和退水，放逐弃票不选目标', () => {
    const g = game();
    g.untilTool('sheriff_signup');
    for (const seat of g.waiting()) {
      expect(names(g.toolsOf(seat))).toEqual(['sheriff_signup', 'sheriff_stay_off']);
      g.ok(seat, [9, 10].includes(seat) ? 'sheriff_signup' : 'sheriff_stay_off');
    }
    expect(actionMenu(g.toolsOf(g.waiting()[0]))).toContain('sheriff_withdraw');
    expect(actionMenu(g.toolsOf(g.waiting()[0]))).toContain('speak');
    g.untilTool('sheriff_vote');
    const voter = g.waiting()[0];
    expect(names(g.toolsOf(voter))).toEqual(['sheriff_vote', 'sheriff_abstain']);
    expect(g.act(voter, 'sheriff_vote', { candidateSeat: 3 })?.code).toBe('INVALID_ARGUMENT');
    for (const seat of g.waiting()) g.ok(seat, 'sheriff_vote', { candidateSeat: 9 });
    expect(g.state.sheriff).toBe(9);
    g.untilTool('vote');
    const seat = g.waiting()[0];
    expect(names(g.toolsOf(seat))).toEqual(['vote', 'vote_abstain']);
    g.ok(seat, 'vote_abstain');
    expect(g.pending!.submissions[seat]).toEqual({ tool: 'vote', args: { target: null } });
  });

  it.each([['badge_transfer', { recipientSeat: 12 }, 12], ['badge_tear', {}, null]] as const)('警徽 %s 执行明确动作，不能混用另一种参数', (tool, args, sheriff) => {
    const g = game();
    g.untilTool('sheriff_signup');
    for (const seat of g.waiting()) domain(g, seat, 'sheriff_signup', { run: seat === 9 });
    g.untilTool('vote');
    for (const seat of g.waiting()) domain(g, seat, 'vote', { target: seat === 9 ? 1 : 9 });
    expect(names(g.toolsOf(9))).toEqual(['badge_transfer', 'badge_tear']);
    expect(g.pending!.prompts[9]).toContain('recipientSeat');
    expect(g.pending!.prompts[9]).not.toContain('null');
    expect(g.act(9, 'badge_transfer', { recipientSeat: null })?.code).toBe('INVALID_ARGUMENT');
    expect(g.act(9, 'badge_tear', { recipientSeat: 12 })?.code).toBe('INVALID_ARGUMENT');
    g.ok(9, tool, args);
    expect(g.state.sheriff).toBe(sheriff);
  });

  it('自爆与不自爆分开；不能忽略 explode:false 后误执行自爆', () => {
    const g = game({ ...noSheriff, 'explode.window': 'between_speeches' });
    g.untilTool('wolf_decline_explode');
    const seat = g.waiting()[0];
    expect(names(g.toolsOf(seat))).toEqual(['wolf_explode', 'wolf_decline_explode']);
    expect(g.act(seat, 'wolf_explode', { explode: false })?.code).toBe('INVALID_ARGUMENT');
    g.ok(seat, 'wolf_decline_explode');
    expect(g.state.players[seat - 1].alive).toBe(true);
    expect(g.events.some((e) => e.type === 'explode')).toBe(false);
    const other = g.waiting()[0];
    g.ok(other, 'wolf_explode');
    for (const remaining of g.waiting()) g.ok(remaining, 'wolf_decline_explode');
    expect(g.state.players[other - 1].alive).toBe(false);
    const intr = game({ ...noSheriff, 'explode.window': 'interrupt' });
    intr.untilTool('speak');
    expect(intr.act(1, 'wolf_explode', { explode: false })?.code).toBe('INVALID_ARGUMENT');
    expect(intr.state.players[0].alive).toBe(true);
  });

  it('缺省版本的旧存档仍使用 v1 参数并精确重放，v2 存档重放也不改变动作', () => {
    const rules = buildRules('standard12', noSheriff);
    delete rules.toolsetVersion;
    const options = { id: 'legacy', seed: 'legacy', rules, deal: DEAL12 };
    const initial = createGame(options);
    expect(initial.state.pending!.tools[8][0].params[0]).toMatchObject({ name: 'target', nullable: true });
    const action = { seat: 8, call: { tool: 'guard_protect', args: { target: null } } };
    const result = submit(initial.state, action);
    expect(result.error).toBeUndefined();
    expect(replay(options, [action])).toEqual({ state: result.state, events: [...initial.events, ...result.events] });
    const g = atWitch();
    g.ok(6, 'witch_save');
    expect(replay(g.options, g.actions)).toEqual({ state: g.state, events: g.events });
  });

  it('旧版女巫纠错菜单给出完整救人示例，不能自救时不提示救人', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.untilTool('witch_act');
    // 空刀时只提供毒药字段，不能把它误解释为救人目标。
    expect(actionMenu(g.toolsOf(6))).not.toContain('只救刀口');
    const save = new TestGame({ deal: DEAL12, values: noSheriff });
    save.until((x) => x.hasTool('witch_act'), (_seat, tools) => tools.some((t) => t.name === 'wolf_kill') ? { tool: 'wolf_kill', args: { target: 7 } } : undefined);
    expect(actionMenu(save.toolsOf(6))).toContain('只救刀口：{"save":true,"poisonTarget":null}');
    expect(save.act(6, 'witch_act', { save: true, poisonTarget: 7 })?.reason).toBe('同一晚不能既救又毒');
    expect(replay(save.options, save.actions)).toEqual({ state: save.state, events: save.events });
  });
});
