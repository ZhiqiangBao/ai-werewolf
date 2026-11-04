import { describe, expect, it } from 'vitest';
import {
  allPresets,
  buildRuleCard,
  buildRules,
  createGame,
  engineCatalog,
  projectSeat,
  registerPreset,
  registerRole,
  seatParam,
  submit,
  validateRules,
  type RoleModule,
} from '../src/index';
import { TestGame } from './harness';

describe('版型与规则', () => {
  it('新局默认死亡后先判胜负，并拒绝未知死亡结算版本', () => {
    const rules = buildRules('classic9');
    expect(rules.deathResolutionVersion).toBe(2);
    const currentCard = buildRuleCard(rules);
    expect(currentCard).toContain('胜负已分则立即结束，不再处理出局技能、警徽或遗言');
    expect(currentCard).toContain('若胜负已分，不再发动开枪技能。');
    expect(currentCard).toContain('若技能造成新的出局，先判定胜负');
    const legacy = { ...rules, deathResolutionVersion: undefined, hunterShotVersion: undefined, electionExplosionVersion: undefined };
    expect(validateRules(legacy)).toEqual([]);
    expect(buildRuleCard(legacy)).toContain('先处理本次出局触发的技能及其引发的后续出局，再判定胜负');
    expect(buildRuleCard(legacy)).not.toContain('胜负已分则立即结束');
    expect(buildRuleCard(legacy)).not.toContain('若胜负已分，不再发动开枪技能。');
    expect(validateRules({ ...rules, deathResolutionVersion: 3 as 2 })).toContain('死亡结算版本只支持 1 或 2');
  });

  it('内置版型都能通过校验并开局（SYS-05 / MOD-04）', () => {
    for (const p of allPresets()) {
      const rules = buildRules(p.id);
      expect(validateRules(rules), p.id).toEqual([]);
      expect(() => createGame({ id: 'x', rules, seed: 's' })).not.toThrow();
    }
  });

  it('9 人局没有守卫：夜间顺序和规则卡都不出现守卫', () => {
    const r9 = buildRules('classic9');
    expect(r9.nightOrder).toEqual(['werewolf', 'seer', 'witch']);
    expect(buildRuleCard(r9)).not.toContain('守卫');
    const r12 = buildRules('standard12');
    expect(r12.nightOrder).toEqual(['guard', 'werewolf', 'seer', 'witch']);
    expect(buildRuleCard(r12)).toContain('守卫');
  });

  it('精简规则卡保留特殊身份及可配置结算边界', () => {
    const mirror = buildRuleCard(buildRules('mirror12'));
    expect(mirror).toContain('阵营查验始终显示好人');
    expect(mirror).toContain('学习夜天亮出局时，按猎人规则判断是否可开枪');
    expect(mirror).toContain('若猎枪造成你的出局，且胜负未分、枪仍可用');
    expect(mirror).toContain('守卫或模仿守卫当晚守护，且女巫同时救治同一名狼人攻击目标时（同守同救），该玩家仍会出局');
    const base = buildRules('standard12');
    const card = buildRuleCard({ ...base, electionVersion: 3, values: { ...base.values,
      'sheriff.explodeInElection': 'postpone_vote', 'lastWords.shotAfterFirstNight': false,
      'witch.selfSave': 'first_night', 'guard.noConsecutive': true } });
    expect(card).toContain('竞选才延期至次日');
    expect(card).toContain('平票候选人的补充发言和投票时不能退出竞选');
    expect(card).toContain('猎人第 1 夜出局时没有遗言');
    expect(card).toContain('仅第 1 夜可以自救');
    expect(card).toContain('不能连续两夜守护同一名玩家');
  });

  it('非法版型给出中文原因', () => {
    const base = buildRules('standard12');
    expect(validateRules({ ...base, roles: [...base.roles.slice(0, 11), 'nobody'] })).toContain('身份「nobody」没有注册');
    expect(validateRules({ ...base, roles: [...base.roles.slice(0, 11), 'seer'] }).join()).toContain('预言家最多 1 名');
    const noVillager = base.roles.map((r) => (r === 'villager' ? 'werewolf' : r));
    expect(validateRules({ ...base, roles: noVillager })).toContain('屠边局至少需要 1 名平民');
    expect(validateRules({ ...base, playerCount: 13 }).join()).toContain('不一致');
  });

  it('开局页不能改写不可编辑的选项', () => {
    const r = buildRules('standard12', { 'limits.maxDays': 99, 'hunter.shootOnPoison': true, 'witch.selfSave': 'first_night' });
    expect(r.values['limits.maxDays']).toBe(15);
    expect(r.values['hunter.shootOnPoison']).toBe(false);
    expect(r.values['witch.selfSave']).toBe('first_night');
  });

  it('同一种子发牌相同，不同种子发牌不同（MOD-05）', () => {
    const rules = buildRules('standard12');
    const deal = (seed: string) => createGame({ id: 'x', rules, seed }).state.players.map((p) => p.role).join();
    expect(deal('a')).toBe(deal('a'));
    expect(new Set(['a', 'b', 'c', 'd', 'e'].map(deal)).size).toBeGreaterThan(1);
  });

  it('目录包含全部身份、版型和规则选项', () => {
    const c = engineCatalog();
    expect(c.roles.map((r) => r.id)).toEqual(expect.arrayContaining(['werewolf', 'villager', 'seer', 'witch', 'hunter', 'guard', 'idiot']));
    expect(c.presets.map((p) => p.id)).toEqual(expect.arrayContaining(['standard12', 'classic9', 'idiot12']));
    expect(c.options.some((o) => o.key === 'witch.selfSave')).toBe(true);
  });
});

describe('扩展：新增身份只需要一个模块（MOD-03）', () => {
  const lookout: RoleModule = {
    id: 'test_lookout',
    name: '瞭望者',
    faction: 'good',
    category: 'god',
    maxPerGame: 1,
    summary: '测试身份：每晚指定一名玩家，得知他今晚是否睁眼行动。',
    nightPhase: { id: 'test_lookout', order: 35 },
    ruleCard: () => ['瞭望者：每晚指定一名玩家，得知他今晚是否行动过。'],
    steps: {
      'night:test_lookout': {
        run(ctx, step) {
          const seats = ctx.seatsOf('test_lookout');
          if (!seats.length) return;
          ctx.ask({
            step,
            actors: seats,
            tools: (seat) => [
              {
                name: 'lookout_watch',
                title: '瞭望',
                description: '指定一名其他存活玩家。',
                params: [seatParam('target', '瞭望目标', ctx.alive().filter((x) => x !== seat), '不瞭望')],
              },
            ],
            prompt: () => '请选择今晚瞭望的玩家。',
            title: `第${ctx.state.day}夜 · 瞭望者`,
            publicStage: '夜晚',
          });
        },
        decide(ctx, _step, subs) {
          for (const [seat, call] of Object.entries(subs)) {
            const target = call.args.target as number | null;
            const acted = target !== null && ['werewolf', 'seer', 'witch', 'guard'].includes(ctx.player(target).role);
            ctx.priv([Number(seat)], 'lookout.result', target === null ? '你今晚没有瞭望。' : `${target}号今晚${acted ? '行动过' : '没有行动'}。`, {});
          }
        },
        fallback: () => ({ tool: 'lookout_watch', args: { target: null } }),
      },
    },
  };

  it('注册身份和版型后即可开局，工具出现在座位投影里', () => {
    registerRole(lookout);
    registerPreset({
      id: 'test_lookout10',
      name: '瞭望者测试局',
      description: '测试用版型',
      roles: ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'test_lookout', 'villager', 'villager', 'villager', 'villager'],
    });
    const rules = buildRules('test_lookout10');
    expect(validateRules(rules)).toEqual([]);
    expect(rules.nightOrder).toEqual(['werewolf', 'seer', 'test_lookout', 'witch']);
    expect(buildRuleCard(rules)).toContain('瞭望者');

    const deal = ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'test_lookout', 'villager', 'villager', 'villager', 'villager'];
    const g = new TestGame({ preset: 'test_lookout10', deal, values: { 'sheriff.enabled': false } });
    g.until((x) => x.hasTool('lookout_watch'));
    const task = g.view(6).task;
    expect(task?.tools[0]).toMatchObject({ name: 'lookout_watch', params: [{ kind: 'seat', nullable: true }] });
    g.ok(6, 'lookout_watch', { target: 1 });
    expect(g.view(6).events.some((e) => e.type === 'lookout.result' && e.text === '1号今晚行动过。')).toBe(true);
    expect(g.view(1).events.some((e) => e.type === 'lookout.result')).toBe(false);
  });

  it('自定义身份列表组成新版型', () => {
    const roles = ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager'];
    const rules = buildRules('standard12', {}, { roles, name: '10 人自定义' });
    expect(validateRules(rules)).toEqual([]);
    const r = createGame({ id: 'x', rules, seed: 'custom' });
    expect(r.state.players).toHaveLength(10);
    const first = r.state.pending!;
    const seat = first.actors[0];
    const next = submit(r.state, { seat, call: { tool: '', args: {} }, auto: true });
    expect(next.error).toBeUndefined();
    expect(projectSeat(next.state, [...r.events, ...next.events], seat).presetName).toBe('10 人自定义');
  });
});
