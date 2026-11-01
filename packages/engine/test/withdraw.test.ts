import { describe, expect, it } from 'vitest';
import { buildRules, replay, seatTools, submit } from '../src/index';
import { DEAL12, lastPublic, TestGame } from './harness';

function campaign(version: 1 | 2 | 3 = 3, candidates = [9, 10, 11]) {
  const g = new TestGame({ deal: DEAL12, electionVersion: version });
  g.night();
  for (const s of g.waiting()) g.ok(s, 'sheriff_signup', { run: candidates.includes(s) });
  return g;
}
function finalConfirmation(g: TestGame) {
  g.until((x) => x.pending?.step.type === 'sheriff.withdraw');
}
function stay(g: TestGame) {
  for (const seat of g.waiting()) g.ok(seat, 'sheriff_stay');
}

describe('警上发言后退水', () => {
  it('新局使用版本 3，旧版保留原流程与固定目录', () => {
    expect(buildRules('standard12').electionVersion).toBe(3);
    for (const version of [1, 2] as const) {
      const g = campaign(version);
      const first = g.waiting()[0]; g.auto(first);
      expect(g.view(first).interrupts).toEqual([]);
      expect(seatTools(g.state, first).some((t) => t.name === 'sheriff_stay')).toBe(false);
      g.untilTool('sheriff_vote');
      expect(g.events.some((e) => e.type === 'sheriff.withdraw.window')).toBe(false);
      expect(replay(g.options, g.actions).state).toEqual(g.state);
    }
  });

  it('发言后可退水，但不能追加发言、打断下一位或重复退出', () => {
    const g = campaign(); const first = g.waiting()[0];
    const beforeCatalog = JSON.stringify(seatTools(g.state, first));
    g.ok(first, 'speak', { content: '我的竞选发言。' });
    const pending = structuredClone(g.pending);
    expect(g.view(first).interrupts.find((t) => t.name === 'sheriff_withdraw')?.params[0]).toMatchObject({ maxLength: 0 });
    expect(g.act(first, 'sheriff_withdraw', { content: '不能偷发一段话' })).toBeDefined();
    expect(g.state.election.withdrawn).not.toContain(first);
    g.ok(first, 'sheriff_withdraw', { content: '' });
    expect(g.pending).toEqual(pending);
    expect(g.state.election.withdrawn).toContain(first);
    expect(g.events.filter((e) => e.type === 'speech' && e.payload.seat === first)).toHaveLength(1);
    expect(lastPublic(g, 'sheriff.withdraw')?.payload.seat).toBe(first);
    expect(g.act(first, 'sheriff_withdraw', { content: '' })).toBeDefined();
    expect(g.events.filter((e) => e.type === 'sheriff.withdraw')).toHaveLength(1);
    expect(JSON.stringify(seatTools(g.state, first))).toBe(beforeCatalog);
  });

  it('未发言候选人可以提前退水，排定的该席竞选发言随后跳过', () => {
    const g = campaign();
    const later = g.state.election.candidates.find((s) => s !== g.waiting()[0])!;
    g.ok(later, 'sheriff_withdraw', { content: '' });
    finalConfirmation(g);
    expect(g.waiting()).not.toContain(later);
    expect(g.events.some((e) => e.type === 'speech' && e.payload.seat === later)).toBe(false);
  });

  it('最后发言者有最终退水机会，收齐后才开放警长投票', () => {
    const g = campaign(); finalConfirmation(g);
    const last = g.events.filter((e) => e.type === 'speech').at(-1)!.payload.seat as number;
    expect(g.waiting()).toContain(last);
    const before = g.events.length;
    g.ok(last, 'sheriff_withdraw', { content: '' });
    expect(g.pending?.step.type).toBe('sheriff.withdraw');
    expect(g.view(last).task?.submitted).toBe(true);
    expect(g.view(last).interrupts).toEqual([]);
    expect(g.events.slice(before).some((e) => e.type === 'sheriff.withdraw')).toBe(false);
    stay(g);
    expect(g.pending?.step.type).toBe('sheriff.vote');
    expect(g.pending?.tools[g.waiting()[0]][0].params[0]).toMatchObject({ options: g.state.election.candidates.filter((s) => s !== last) });
    expect(g.waiting()).not.toContain(last);
    expect(g.events.filter((e) => e.type === 'speech' && e.payload.seat === last)).toHaveLength(1);
    expect(replay(g.options, g.actions).state).toEqual(g.state);
  });

  it('全部退出则无警长；只剩一名确认继续的候选人直接当选', () => {
    const none = campaign(); finalConfirmation(none);
    for (const s of none.waiting()) none.ok(s, 'sheriff_withdraw', { content: '' });
    expect(none.state.election.status).toBe('done');
    expect(none.state.sheriff).toBeNull();
    expect(lastPublic(none, 'sheriff.none')).toBeDefined();
    const one = campaign(); finalConfirmation(one);
    const keeper = one.waiting()[0];
    for (const s of one.waiting()) one.ok(s, s === keeper ? 'sheriff_stay' : 'sheriff_withdraw', s === keeper ? {} : { content: '' });
    expect(one.state.sheriff).toBe(keeper);
    expect(one.state.election.status).toBe('done');
  });

  it('最终确认超时默认继续，投票开始后退水和过期请求都无效', () => {
    const g = campaign(); finalConfirmation(g);
    const decision = g.pending!.id;
    for (const s of g.waiting()) g.auto(s);
    expect(g.pending?.step.type).toBe('sheriff.vote');
    expect(g.state.election.withdrawn).toEqual([]);
    for (const s of g.state.election.candidates) {
      expect(g.view(s).interrupts).toEqual([]);
      expect(g.act(s, 'sheriff_withdraw', { content: '' })).toBeDefined();
    }
    const stale = submit(g.state, { seat: 9, decisionId: decision, call: { tool: 'sheriff_withdraw', args: { content: '' } } });
    expect(stale.error?.code).toBe('STALE_DECISION');
    expect(stale.state.election.withdrawn).toEqual([]);
  });

  it('竞选 PK 不提供退水，也不重新打开最终确认', () => {
    const g = campaign(3, [9, 10]); finalConfirmation(g); stay(g);
    for (const [i, s] of g.waiting().entries()) g.ok(s, 'sheriff_vote', { target: i % 2 ? 9 : 10 });
    expect(g.pending?.step.kind).toBe('sheriff_pk');
    for (const s of [9, 10]) expect(g.view(s).interrupts).toEqual([]);
    expect(g.toolsOf(g.waiting()[0]).some((t) => t.name === 'sheriff_withdraw')).toBe(false);
    const windows = g.events.filter((e) => e.type === 'sheriff.withdraw.window').length;
    g.untilTool('sheriff_vote');
    expect(g.pending?.step.round).toBe(2);
    expect(g.events.filter((e) => e.type === 'sheriff.withdraw.window')).toHaveLength(windows);
  });

  it('警上自爆保留退水记录，次日先询问自爆再直接续投，徽落地后通报夜间信息', () => {
    const g = campaign(); const quitter = g.state.election.candidates.find((s) => s !== g.waiting()[0])!;
    g.ok(quitter, 'sheriff_withdraw', { content: '' });
    g.ok(1, 'wolf_explode'); g.toNight(); g.night();
    expect(g.pending?.step.electionResume).toBe(true);
    for (const s of g.waiting()) g.ok(s, 'wolf_explode_decision', { explode: false });
    expect(g.pending?.step.type).toBe('sheriff.vote');
    expect(g.state.election.withdrawn).toContain(quitter);
    expect(g.events.some((e) => e.day === 2 && e.type === 'sheriff.withdraw.window')).toBe(false);
    expect(g.events.some((e) => e.day === 2 && e.type === 'dawn')).toBe(false);
    const target = g.state.election.candidates.find((s) => s !== quitter)!;
    for (const s of g.waiting()) g.ok(s, 'sheriff_vote', { target });
    const day = g.events.filter((e) => e.day === 2 && e.phase === 'day');
    expect(day.findIndex((e) => e.type === 'vote.result')).toBeLessThan(day.findIndex((e) => e.type === 'dawn'));
    expect(replay(g.options, g.actions).state).toEqual(g.state);
  });
});
