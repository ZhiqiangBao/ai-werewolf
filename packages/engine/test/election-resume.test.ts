import { describe, expect, it } from 'vitest';
import { replay, seatTools } from '../src/index';
import { DEAL12, lastPublic, TestGame, type NightPlan } from './harness';

function campaign(plan: NightPlan = {}, candidates = [1, 9, 10, 11], values: Record<string, unknown> = {}) {
  const g = new TestGame({ deal: DEAL12, values });
  g.night(plan);
  g.untilTool('sheriff_signup');
  for (const s of g.waiting()) g.ok(s, 'sheriff_signup', { run: candidates.includes(s) });
  g.until((x) => x.pending?.step.kind === 'campaign');
  return g;
}
function resume(g: TestGame, plan: NightPlan = {}) {
  g.toNight(); g.night(plan);
  expect(lastPublic(g, 'sheriff.resume')?.payload.mode).toBe('vote');
}
function decline(g: TestGame) {
  expect(g.pending?.step.electionResume).toBe(true);
  for (const s of g.waiting()) g.ok(s, 'wolf_explode_decision', { explode: false });
}

describe('警上自爆后直接续投', () => {
  it('新局默认延期，先公布首夜、猎枪及连锁，再自爆者与首夜死者遗言', () => {
    const g = campaign({ kill: 7 });
    expect(g.state.rules.values['sheriff.explodeInElection']).toBe('postpone_vote');
    g.ok(1, 'wolf_explode');
    expect(lastPublic(g, 'sheriff.lost')).toBeUndefined();
    expect(lastPublic(g, 'dawn')?.payload.deaths).toEqual([7]);
    expect(g.hasTool('hunter_shoot')).toBe(true);
    expect(g.events.some((e) => e.type === 'speech' && e.payload.kind === 'lastwords')).toBe(false);
    g.ok(7, 'hunter_shoot', { target: 9 });
    expect(g.pending?.actors).toEqual([1]);
    for (const expected of [1, 7, 9]) {
      expect(g.pending?.actors).toEqual([expected]);
      expect(g.pending?.step.kind).toBe('lastwords');
      expect(g.view(2).interrupts).toEqual([]);
      g.auto(expected);
    }
    expect(g.state.phase).toBe('night');
    expect(g.events.filter((e) => e.type === 'dawn' && e.day === 1)).toHaveLength(1);
    expect(g.events.filter((e) => e.type === 'speech' && e.payload.kind === 'lastwords').map((e) => e.payload.seat)).toEqual([1, 7, 9]);
    expect(g.events.filter((e) => e.type === 'vote.result')).toHaveLength(0);
    expect(replay(g.options, g.actions)).toEqual({ state: g.state, events: g.events });
  });

  it.each([{ kill: 7, poison: 7 }, { kill: null, poison: 7 }])('猎人死因含毒药时不再询问开枪：%j', (plan) => {
    const g = campaign(plan);
    g.ok(1, 'wolf_explode');
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(g.pending?.actors).toEqual([1]);
    g.toNight();
    expect(g.events.some((e) => e.type === 'hunter.shot')).toBe(false);
    expect(g.events.filter((e) => e.type === 'speech' && e.payload.kind === 'lastwords').map((e) => e.payload.seat)).toEqual([1, 7]);
  });

  it('平安夜也只公布一次，自爆者完成遗言后入夜', () => {
    const g = campaign(); g.ok(1, 'wolf_explode'); g.toNight();
    expect(g.events.filter((e) => e.type === 'dawn').map((e) => e.payload.deaths)).toEqual([[]]);
    expect(g.events.filter((e) => e.type === 'speech' && e.payload.kind === 'lastwords').map((e) => e.payload.seat)).toEqual([1]);
  });

  it('次日先公布夜间出局，再直接投票；不再报名或竞选发言，不给第二夜死者遗言', () => {
    const g = campaign(); g.ok(1, 'wolf_explode'); resume(g, { kill: 12 });
    expect(g.events.filter((e) => e.day === 2 && e.type === 'speech')).toHaveLength(0);
    const day = g.events.filter((e) => e.day === 2 && e.phase === 'day');
    expect(day.findIndex((e) => e.type === 'dawn')).toBeLessThan(day.findIndex((e) => e.type === 'sheriff.resume'));
    decline(g);
    expect(g.hasTool('sheriff_vote')).toBe(true);
    expect(g.pending!.tools[2][0].params[0]).toMatchObject({ options: [9, 10, 11] });
    expect(day.some((e) => e.type === 'sheriff.start' || e.type === 'sheriff.order')).toBe(false);
  });

  it('保留最初报名与退水资格，原退水者不会因延期变成警下', () => {
    const g = campaign();
    const withdrawn = g.pending!.actors[0];
    g.ok(withdrawn, 'sheriff_withdraw', { content: '' });
    g.ok(1, 'wolf_explode'); resume(g); decline(g);
    expect(g.waiting()).not.toContain(withdrawn);
    expect(g.waiting()).not.toContain(9);
    expect(lastPublic(g, 'sheriff.resume')?.payload.withdrawn).toContain(withdrawn);
    expect(g.state.election.withdrawn).toContain(withdrawn);
  });

  it('显式允许退水投票时，延期后仍保留该资格', () => {
    const g = campaign({}, [1, 9, 10, 11], { 'sheriff.withdrawnCanVote': true });
    const withdrawn = g.pending!.actors[0];
    g.ok(withdrawn, 'sheriff_withdraw', { content: '' });
    g.ok(1, 'wolf_explode'); resume(g); decline(g);
    if (withdrawn !== 1) expect(g.waiting()).toContain(withdrawn);
  });

  it('续投前的第二次自爆才流徽，取消投票并不重复公布首夜或重开竞选', () => {
    const g = campaign(); g.ok(1, 'wolf_explode'); resume(g);
    const catalog = seatTools(g.state, 2);
    expect(catalog.some((t) => t.name === 'wolf_explode_decision')).toBe(true);
    for (const s of g.waiting()) g.ok(s, 'wolf_explode_decision', { explode: s === 2 });
    expect(lastPublic(g, 'sheriff.lost')).toBeDefined();
    expect(g.state.election.explosions).toBe(2);
    g.toNight();
    expect(g.state.election.status).toBe('done');
    expect(g.events.filter((e) => e.day === 2 && e.type === 'vote.result')).toHaveLength(0);
    expect(g.events.filter((e) => e.type === 'dawn')).toHaveLength(2);
  });

  it('第二夜死亡的候选人被排除，只剩一人时确认未自爆后直接当选', () => {
    const g = campaign({}, [1, 9, 10]); g.ok(1, 'wolf_explode'); resume(g, { kill: 9 }); decline(g);
    expect(g.state.sheriff).toBe(10);
    expect(lastPublic(g, 'sheriff.resume')?.payload.candidates).toEqual([10]);
  });

  it('续投平票仍进入正常 PK，PK 发言中的再次自爆流徽', () => {
    const g = campaign({}, [1, 9, 10]); g.ok(1, 'wolf_explode'); resume(g); decline(g);
    const voters = g.waiting();
    for (let i = 0; i < voters.length; i++) g.ok(voters[i], 'sheriff_vote', { target: i < 4 ? 9 : i < 8 ? 10 : null });
    expect(g.pending?.step.kind).toBe('sheriff_pk');
    g.ok(2, 'wolf_explode');
    expect(lastPublic(g, 'sheriff.lost')).toBeDefined();
  });

  it('首次自爆发生在竞选 PK 时，次日只续投原 PK 候选人，保留第二轮选民', () => {
    const g = campaign({}, [1, 9, 10, 11]);
    g.untilTool('sheriff_vote');
    const voters = g.waiting();
    for (let i = 0; i < voters.length; i++) g.ok(voters[i], 'sheriff_vote', { target: i % 2 ? 9 : 10 });
    expect(g.pending?.step.kind).toBe('sheriff_pk');
    g.ok(1, 'wolf_explode'); resume(g); decline(g);
    expect(g.pending?.step.round).toBe(2);
    expect(g.waiting()).toContain(11);
    expect(g.waiting()).not.toContain(9);
    expect(g.pending?.tools[11][0].params[0]).toMatchObject({ options: [9, 10] });
    expect(g.events.filter((e) => e.day === 2 && e.type === 'sheriff.order')).toHaveLength(0);
    expect(replay(g.options, g.actions)).toEqual({ state: g.state, events: g.events });
  });

  it('自爆者同时是尚未公布的夜间刀口时，死亡和遗言不重复', () => {
    const g = campaign({ kill: 1 }); g.ok(1, 'wolf_explode'); g.toNight();
    expect(g.state.deaths.filter((d) => d.seat === 1)).toHaveLength(1);
    expect(g.events.filter((e) => e.type === 'speech' && e.payload.kind === 'lastwords' && e.payload.seat === 1)).toHaveLength(1);
    expect(lastPublic(g, 'dawn')?.payload.deaths).toEqual([1]);
  });

  it('第二夜死亡的猎人先开枪再续选，但不产生第二夜死者遗言', () => {
    const g = campaign(); g.ok(1, 'wolf_explode'); g.toNight(); g.night({ kill: 7 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    expect(g.events.some((e) => e.day === 2 && e.type === 'sheriff.resume')).toBe(false);
    g.ok(7, 'hunter_shoot', { target: 12 });
    expect(lastPublic(g, 'sheriff.resume')?.day).toBe(2);
    expect(g.events.some((e) => e.day === 2 && e.type === 'speech' && e.payload.kind === 'lastwords')).toBe(false);
    decline(g); expect(g.hasTool('sheriff_vote')).toBe(true);
  });

  it('猎枪处理后胜负成立则结束，不再要求遗言或延期投票', () => {
    const g = campaign({ kill: 7 });
    g.removeSeats(3, 4); g.ok(1, 'wolf_explode');
    expect(g.hasTool('hunter_shoot')).toBe(true);
    g.ok(7, 'hunter_shoot', { target: 2 });
    expect(g.state.result?.winner).toBe('good');
    expect(g.events.some((e) => e.type === 'speech' && e.payload.kind === 'lastwords')).toBe(false);
  });

  it('续选候选人全部在第二夜出局时不重新报名，直接结束竞选', () => {
    const g = campaign({}, [1, 9, 10]); g.ok(1, 'wolf_explode'); resume(g, { kill: 9, poison: 10 });
    expect(g.state.election.status).toBe('done');
    expect(lastPublic(g, 'sheriff.none')).toBeDefined();
    expect(g.events.some((e) => e.day === 2 && e.type === 'sheriff.start')).toBe(false);
  });

  it('显式先遗言后竞选的配置中，报名前自爆不能凭空制造续投候选人', () => {
    const g = new TestGame({ deal: DEAL12, values: { 'sheriff.timing': 'after_last_words' } });
    g.night({ kill: 12 });
    expect(g.pending?.step.kind).toBe('lastwords');
    g.ok(1, 'wolf_explode'); g.toNight(); g.night();
    expect(g.hasTool('sheriff_signup')).toBe(true);
    expect(g.state.election.explosions).toBe(1);
  });
});
