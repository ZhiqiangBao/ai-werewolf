import { describe, expect, it } from 'vitest';
import { replay, seatTools } from '../src/index';
import { DEAL12, lastPublic, TestGame, type NightPlan } from './harness';

function campaign(plan: NightPlan = {}, candidates = [1, 9, 10, 11], values: Record<string, unknown> = {}, electionVersion: 1 | 2 = 2) {
  const g = new TestGame({ deal: DEAL12, values, electionVersion });
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
function elect(g: TestGame, target = 9) {
  expect(g.hasTool('sheriff_vote')).toBe(true);
  for (const seat of g.waiting()) g.ok(seat, 'sheriff_vote', { target });
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

  it('次日先确认自爆并直接投票，警徽落地后才公告；不重发言或给第二夜死者遗言', () => {
    const g = campaign(); g.ok(1, 'wolf_explode'); resume(g, { kill: 12 });
    expect(g.events.filter((e) => e.day === 2 && e.type === 'speech')).toHaveLength(0);
    expect(g.events.some((e) => e.day === 2 && e.type === 'dawn')).toBe(false);
    decline(g);
    expect(g.hasTool('sheriff_vote')).toBe(true);
    expect(g.pending!.tools[2][0].params[0]).toMatchObject({ options: [9, 10, 11] });
    expect(g.waiting()).toContain(12);
    elect(g);
    const day = g.events.filter((e) => e.day === 2 && e.phase === 'day');
    expect(day.findIndex((e) => e.type === 'vote.result')).toBeLessThan(day.findIndex((e) => e.type === 'dawn'));
    expect(day.find((e) => e.type === 'dawn')?.payload.deaths).toEqual([12]);
    expect(day.some((e) => e.type === 'speech' && e.payload.kind === 'lastwords')).toBe(false);
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
    const g = campaign(); g.ok(1, 'wolf_explode'); resume(g, { kill: 12 });
    const catalog = seatTools(g.state, 2);
    expect(catalog.some((t) => t.name === 'wolf_explode_decision')).toBe(true);
    for (const s of g.waiting()) g.ok(s, 'wolf_explode_decision', { explode: s === 2 });
    expect(lastPublic(g, 'sheriff.lost')).toBeDefined();
    expect(g.state.election.explosions).toBe(2);
    expect(lastPublic(g, 'sheriff.lost')!.seq).toBeLessThan(lastPublic(g, 'dawn')!.seq);
    expect(lastPublic(g, 'dawn')?.payload.deaths).toEqual([12]);
    g.toNight();
    expect(g.state.election.status).toBe('done');
    expect(g.events.filter((e) => e.day === 2 && e.type === 'vote.result')).toHaveLength(0);
    expect(g.events.filter((e) => e.type === 'dawn')).toHaveLength(2);
  });

  it('第二夜受害候选人仍可当选，公告后再出局并处理警徽，不提前泄露名单', () => {
    const g = campaign({}, [1, 9, 10]); g.ok(1, 'wolf_explode'); resume(g, { kill: 9 }); decline(g);
    expect(lastPublic(g, 'sheriff.resume')?.payload.candidates).toEqual([9, 10]);
    expect(g.state.players[8].alive).toBe(true);
    elect(g);
    expect(lastPublic(g, 'vote.result')!.seq).toBeLessThan(lastPublic(g, 'dawn')!.seq);
    expect(g.state.sheriff).toBe(9); expect(g.state.players[8].alive).toBe(false);
    expect(g.hasTool('badge_dispose')).toBe(true);
    g.ok(9, 'badge_dispose', { target: 10 }); expect(g.state.sheriff).toBe(10);
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

  it('第二夜死亡的猎人在警徽落地并公告后开枪，不产生第二夜死者遗言', () => {
    const g = campaign(); g.ok(1, 'wolf_explode'); g.toNight(); g.night({ kill: 7 });
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(g.events.some((e) => e.day === 2 && e.type === 'dawn')).toBe(false);
    decline(g); elect(g);
    expect(g.hasTool('hunter_shoot')).toBe(true);
    expect(lastPublic(g, 'vote.result')!.seq).toBeLessThan(lastPublic(g, 'dawn')!.seq);
    g.ok(7, 'hunter_shoot', { target: 12 });
    expect(lastPublic(g, 'sheriff.resume')?.day).toBe(2);
    expect(g.events.some((e) => e.day === 2 && e.type === 'speech' && e.payload.kind === 'lastwords')).toBe(false);
  });

  it('猎枪处理后胜负成立则结束，不再要求遗言或延期投票', () => {
    const g = campaign({ kill: 7 });
    g.removeSeats(3, 4); g.ok(1, 'wolf_explode');
    expect(g.hasTool('hunter_shoot')).toBe(true);
    g.ok(7, 'hunter_shoot', { target: 2 });
    expect(g.state.result?.winner).toBe('good');
    expect(g.events.some((e) => e.type === 'speech' && e.payload.kind === 'lastwords')).toBe(false);
  });

  it('候选人全部在第二夜受害也先完成原名单投票，公告后由新警长移交给存活者', () => {
    const g = campaign({}, [1, 9, 10]); g.ok(1, 'wolf_explode'); resume(g, { kill: 9, poison: 10 });
    expect(lastPublic(g, 'sheriff.resume')?.payload.candidates).toEqual([9, 10]);
    decline(g); elect(g);
    expect(g.state.election.status).toBe('done');
    expect(lastPublic(g, 'sheriff.none')).toBeUndefined();
    expect(lastPublic(g, 'dawn')?.payload.deaths).toEqual([9, 10]);
    g.ok(9, 'badge_dispose', { target: 11 }); expect(g.state.sheriff).toBe(11);
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

  it('续选确认阶段不同夜间结果的公开投影相同，尚未公布的受害狼人也可选择自爆', () => {
    const peace = campaign(), attacked = campaign();
    for (const g of [peace, attacked]) g.ok(1, 'wolf_explode');
    resume(peace); resume(attacked, { kill: 2 });
    expect(peace.spectator().events).toEqual(attacked.spectator().events);
    expect(attacked.view(2).task?.tools.some((t) => t.name === 'wolf_explode_decision')).toBe(true);
    expect(attacked.events.some((e) => e.day === 2 && e.type === 'dawn')).toBe(false);
  });

  it('第二次自爆后才公告并触发第二夜猎枪，猎人及枪口不获得后续夜遗言', () => {
    const g = campaign(); g.ok(1, 'wolf_explode'); resume(g, { kill: 7 });
    for (const s of g.waiting()) g.ok(s, 'wolf_explode_decision', { explode: s === 2 });
    expect(lastPublic(g, 'sheriff.lost')!.seq).toBeLessThan(lastPublic(g, 'dawn')!.seq);
    expect(g.hasTool('hunter_shoot')).toBe(true);
    g.ok(7, 'hunter_shoot', { target: 12 });
    expect(g.pending?.actors).toEqual([2]); g.auto(2);
    expect(g.state.phase).toBe('night');
    expect(g.events.filter((e) => e.day === 2 && e.type === 'speech' && e.payload.kind === 'lastwords').map((e) => e.payload.seat)).toEqual([2]);
  });

  it('第1天显式先公告的配置不覆盖第2天延期续选的警上优先顺序', () => {
    const g = campaign({}, [1, 9, 10], { 'sheriff.timing': 'after_last_words' });
    g.ok(1, 'wolf_explode'); resume(g, { kill: 12 });
    expect(g.events.some((e) => e.day === 2 && e.type === 'dawn')).toBe(false);
    decline(g); elect(g);
    expect(lastPublic(g, 'vote.result')!.seq).toBeLessThan(lastPublic(g, 'dawn')!.seq);
  });

  it.each([true, false])('旧版流程存档保留公告优先与精确重放，版本字段缺省=%s', (missingVersion) => {
    const g = campaign({}, [1, 9, 10], {}, 1);
    if (missingVersion) { delete g.state.rules.electionVersion; delete g.options.rules.electionVersion; }
    g.ok(1, 'wolf_explode'); resume(g, { kill: 12 });
    expect(lastPublic(g, 'dawn')!.seq).toBeLessThan(lastPublic(g, 'sheriff.resume')!.seq);
    decline(g); elect(g);
    expect(replay(g.options, g.actions)).toEqual({ state: g.state, events: g.events });
  });
});
