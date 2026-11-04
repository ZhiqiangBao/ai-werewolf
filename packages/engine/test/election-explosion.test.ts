import { describe, expect, it } from 'vitest';
import { buildRules, replay, submit, validateRules } from '../src/index';
import { lastPublic, TestGame, type NightPlan } from './harness';

const ONE_WOLF = ['werewolf', 'seer', 'villager', 'villager'];
const TWO_WOLVES = ['werewolf', 'werewolf', 'seer', 'villager'];
const WITH_HUNTER = ['werewolf', 'werewolf', 'hunter', 'seer', 'villager'];

function campaign({
  deal = ONE_WOLF,
  plan = {},
  timing = 'before_announcement',
  policy = 'postpone_vote',
  version,
  candidates = [2, 3],
}: {
  deal?: string[];
  plan?: NightPlan;
  timing?: 'before_announcement' | 'after_last_words';
  policy?: 'postpone_vote' | 'postpone' | 'lost';
  version?: 1 | 2 | 'missing';
  candidates?: number[];
} = {}): TestGame {
  const g = new TestGame({ deal, values: { 'sheriff.timing': timing, 'sheriff.explodeInElection': policy } });
  if (version === 'missing') {
    delete g.options.rules.electionExplosionVersion;
    delete g.state.rules.electionExplosionVersion;
  } else if (version !== undefined) {
    g.options.rules.electionExplosionVersion = version;
    g.state.rules.electionExplosionVersion = version;
  }
  g.night(plan);
  g.untilTool('sheriff_signup');
  for (const seat of g.waiting()) g.ok(seat, 'sheriff_signup', { run: candidates.includes(seat) });
  g.until((x) => x.pending?.step.kind === 'campaign');
  return g;
}

function expectExactReplay(g: TestGame): void {
  const savedRules = JSON.parse(JSON.stringify(g.options.rules));
  expect(replay({ ...g.options, rules: savedRules }, g.actions)).toEqual({ state: g.state, events: g.events });
}

describe('警上自爆后的延期公告', () => {
  it('只为采用新版出局结算的新局启用延迟公告', () => {
    const current = buildRules('standard12');
    expect(current.electionExplosionVersion).toBe(2);
    expect(validateRules(current)).toEqual([]);
    expect(validateRules({ ...current, electionExplosionVersion: 1 })).toEqual([]);
    const legacy = buildRules('standard12', {}, { deathResolutionVersion: 1 });
    expect(legacy.electionExplosionVersion).toBe(1);
    expect(validateRules(legacy)).toEqual([]);
    expect(validateRules({ ...legacy, electionExplosionVersion: 2 })).toContain('警长延期公告版本 2 要求出局结算版本 2');
    expect(validateRules({ ...legacy, electionExplosionVersion: 2, deathResolutionVersion: undefined }))
      .toContain('警长延期公告版本 2 要求出局结算版本 2');
    expect(validateRules({ ...current, electionExplosionVersion: 3 as 2 })).toContain('警长延期公告版本只支持 1 或 2');
    delete legacy.electionExplosionVersion;
    delete legacy.deathResolutionVersion;
    delete legacy.hunterShotVersion;
    expect(validateRules(legacy)).toEqual([]);
  });

  it.each(['before_announcement', 'after_last_words'] as const)('最后一狼自爆终局，不承诺延期（%s）', (timing) => {
    const g = campaign({ timing });
    g.ok(1, 'wolf_explode');
    expect(g.state.result?.winner).toBe('good');
    expect(lastPublic(g, 'sheriff.postponed')).toBeUndefined();
    expect(g.events.filter((event) => event.type === 'dawn')).toHaveLength(1);
    expectExactReplay(g);
  });

  it('同一批通报的夜间出局决定胜负，公告公开名单而不公开原因或身份', () => {
    const g = campaign({ deal: TWO_WOLVES, plan: { kill: 3 } });
    expect(lastPublic(g, 'dawn')).toBeUndefined();
    expect(g.state.players[2].alive).toBe(true);
    g.ok(1, 'wolf_explode');
    expect(g.state.result?.winner).toBe('wolf');
    expect(lastPublic(g, 'dawn')?.payload).toEqual({ deaths: [3] });
    expect(lastPublic(g, 'dawn')!.seq).toBeLessThan(lastPublic(g, 'game.decided')!.seq);
    expect(lastPublic(g, 'sheriff.postponed')).toBeUndefined();
    expect(new Set(g.state.deaths.map(({ batch }) => batch)).size).toBe(1);
    expectExactReplay(g);
  });

  it('待猎枪结算，猎枪致胜时不承诺延期', () => {
    const g = campaign({ deal: WITH_HUNTER, plan: { kill: 3 } });
    g.ok(1, 'wolf_explode');
    expect(g.hasTool('hunter_shoot')).toBe(true);
    expect(lastPublic(g, 'sheriff.postponed')).toBeUndefined();
    expect(g.spectator()).not.toHaveProperty('election');
    expect(g.view(2)).not.toHaveProperty('election');
    expect(g.view(2).events.find((event) => event.type === 'dawn')?.payload).toEqual({ deaths: [3] });
    const restored = submit(JSON.parse(JSON.stringify(g.state)), { seat: 3, call: { tool: 'hunter_shoot', args: { target: 2 } } });
    const beforeShot = g.events.length;
    g.ok(3, 'hunter_shoot', { target: 2 });
    expect(g.state.result?.winner).toBe('good');
    expect(lastPublic(g, 'sheriff.postponed')).toBeUndefined();
    expect(restored).toEqual({ state: g.state, events: g.events.slice(beforeShot) });
    expectExactReplay(g);
  });

  it.each(['postpone_vote', 'postpone'] as const)('游戏继续时公告一次，并保留相应的竞选续选政策（%s）', (policy) => {
    const g = campaign({ deal: TWO_WOLVES, policy });
    g.ok(1, 'wolf_explode');
    g.toNight();
    const announcements = g.events.filter((event) => event.type === 'sheriff.postponed');
    expect(announcements).toHaveLength(1);
    expect(announcements[0].audience).toBe('public');
    expect(announcements[0].seq).toBeGreaterThan(lastPublic(g, 'dawn')!.seq);
    g.night();
    expect(lastPublic(g, 'sheriff.resume')?.payload.candidates).toEqual([2, 3]);
    expectExactReplay(g);
  });

  it('非合批延期模式也等待尚未通报的夜间出局；夜间出局终局时不承诺延期', () => {
    const g = campaign({ deal: TWO_WOLVES, policy: 'postpone', plan: { kill: 3 } });
    g.ok(1, 'wolf_explode');
    g.toNight();
    expect(g.state.result?.winner).toBe('wolf');
    expect(lastPublic(g, 'dawn')?.payload.deaths).toEqual([3]);
    expect(lastPublic(g, 'sheriff.postponed')).toBeUndefined();
    expect(new Set(g.state.deaths.map(({ batch }) => batch)).size).toBe(2);
    expectExactReplay(g);
  });

  it('独立夜间出局遗言期间再次自爆，保留流徽并取消尚未发布的延期通知', () => {
    const g = campaign({ deal: ['werewolf', 'werewolf', 'werewolf', 'seer', 'villager', 'villager'],
      policy: 'postpone', plan: { kill: 5 } });
    g.ok(1, 'wolf_explode');
    expect(g.pending?.step.kind).toBe('lastwords');
    g.auto(1);
    expect(g.pending?.actors).toEqual([5]);
    expect(g.view(2).interrupts.some((tool) => tool.name === 'wolf_explode')).toBe(true);
    g.ok(2, 'wolf_explode');
    expect(g.state.result).toBeNull();
    expect(lastPublic(g, 'sheriff.lost')).toBeDefined();
    g.toNight();
    expect(lastPublic(g, 'sheriff.postponed')).toBeUndefined();
    expect(g.state.election.explosions).toBe(2);
    expectExactReplay(g);
  });

  it.each([true, false])('续选时依据公开出局结果过滤原候选人：是否剩下一人=%s', (oneRemaining) => {
    const g = campaign({
      deal: ['werewolf', 'werewolf', 'witch', 'seer', 'villager', 'villager', 'villager'],
      candidates: [5, 6],
      plan: { kill: 5, poison: oneRemaining ? null : 6 },
    });
    g.ok(1, 'wolf_explode');
    g.toNight();
    g.night();
    expect(lastPublic(g, 'sheriff.resume')?.payload.candidates).toEqual(oneRemaining ? [6] : []);
    if (oneRemaining) {
      expect(g.pending?.step.electionResume).toBe(true);
      g.ok(2, 'wolf_explode_decision', { explode: false });
      expect(g.state.sheriff).toBe(6);
    } else {
      expect(lastPublic(g, 'sheriff.none')).toBeDefined();
      expect(g.state.sheriff).toBeNull();
    }
    expectExactReplay(g);
  });

  it.each([1, 'missing'] as const)('保留旧房间的公告次序和行动重放（版本 %s）', (version) => {
    const g = campaign({ version });
    g.ok(1, 'wolf_explode');
    expect(g.state.result?.winner).toBe('good');
    expect(lastPublic(g, 'sheriff.postponed')!.seq).toBeLessThan(lastPublic(g, 'dawn')!.seq);
    expectExactReplay(g);
  });
});
