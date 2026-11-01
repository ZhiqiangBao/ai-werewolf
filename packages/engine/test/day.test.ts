import type { Seat } from '@werewolf/protocol';
import { describe, expect, it } from 'vitest';
import { nextIn, ringOrder } from '../src/flow/order';
import { tally } from '../src/flow/tally';
import { DEAL12, TestGame, lastPublic } from './harness';

const noSheriff = { 'sheriff.enabled': false };

function spokeLastWords(g: TestGame, seat: Seat): boolean {
  return g.events.some((e) => e.type === 'speech' && e.payload.kind === 'lastwords' && e.payload.seat === seat);
}

/** 第 1 天竞选：cands 上警，其余人按 votes 投票（未列出者弃票）。 */
function election(g: TestGame, cands: Seat[], votes: Record<number, Seat | null> = {}): void {
  g.until((x) => x.hasTool('sheriff_signup'));
  for (const s of g.waiting()) g.ok(s, 'sheriff_signup', { run: cands.includes(s) });
  if (cands.length < 2 || cands.length === g.alive().length) return;
  g.until((x) => x.hasTool('sheriff_vote'));
  for (const s of g.waiting()) g.ok(s, 'sheriff_vote', { target: votes[s] ?? null });
}

const everyone = (target: Seat, except: Seat[] = []) =>
  Object.fromEntries(Array.from({ length: 12 }, (_, i) => i + 1).filter((s) => !except.includes(s)).map((s) => [s, target]));

describe('计票（DAY-01）', () => {
  const ballots = (list: [Seat, Seat | null, number][]) => list.map(([voter, target, weight]) => ({ voter, target, weight }));

  it('警长 1.5 票对两名普通玩家 2 票：后者出局', () => {
    const t = tally(ballots([[1, 3, 3], [2, 5, 2], [4, 5, 2]]));
    expect(t.top).toEqual([5]);
  });

  it('警长 + 2 人共 3.5 票对 3 人 3 票：前者出局', () => {
    const t = tally(ballots([[1, 3, 3], [2, 3, 2], [4, 3, 2], [6, 5, 2], [7, 5, 2], [8, 5, 2]]));
    expect(t.top).toEqual([3]);
    expect(t.topWeight / 2).toBe(3.5);
  });

  it('平票进入 PK，弃票不计', () => {
    const t = tally(ballots([[1, 4, 2], [2, 4, 2], [6, 5, 2], [7, 5, 2], [8, null, 0]]));
    expect(t.top).toEqual([4, 5]);
    expect(t.abstain).toEqual([8]);
  });
});

describe('发言顺序（DAY-03）', () => {
  it('存活 1、2、3、6、8，锚点 5 顺时针：6、8、1、2、3', () => {
    const alive = [1, 2, 3, 6, 8];
    const first = nextIn(9, 5, 'clockwise', alive)!;
    expect(ringOrder(9, first, 'clockwise', alive)).toEqual([6, 8, 1, 2, 3]);
  });

  it('逆时针在 1 与 N 之间折返', () => {
    const alive = [1, 2, 3, 6, 8];
    const first = nextIn(9, 2, 'counterclockwise', alive)!;
    expect(ringOrder(9, first, 'counterclockwise', alive)).toEqual([1, 8, 6, 3, 2]);
  });
});

describe('放逐投票', () => {
  it('平票 PK：PK 台上的人不投票，再平票为平安日（DAY-02）', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: null });
    g.toVote();
    g.vote({ 1: 9, 2: 9, 3: 10, 4: 10 });
    expect(lastPublic(g, 'vote.result')?.payload).toMatchObject({ outcome: 'pk', seats: [9, 10] });
    g.toVote();
    expect(g.waiting()).not.toContain(9);
    expect(g.waiting()).not.toContain(10);
    expect(g.toolsOf(1)[0].params[0]).toMatchObject({ options: [9, 10] });
    g.vote({ 1: 9, 2: 9, 3: 10, 4: 10 });
    expect(lastPublic(g, 'vote.result')?.text).toContain('平安日');
    expect(g.state.phase).toBe('night');
  });

  it('同时投票：未出结果前其他座位看不到已投内容（VIS-04）', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: null });
    g.toVote();
    g.ok(1, 'vote', { target: 9 });
    const other = g.view(5);
    expect(JSON.stringify(other)).not.toContain('你投给了');
    expect(other.events.some((e) => e.type === 'vote.result')).toBe(false);
    expect(g.view(1).task?.submittedText).toBe('你投给了 9号。');
  });
});

describe('遗言（DAY-04 / DAY-11）', () => {
  it('首夜出局有遗言，第 2 夜起没有', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: 9 });
    g.toNight();
    expect(spokeLastWords(g, 9)).toBe(true);
    g.night({ kill: 10 });
    g.toNight();
    expect(spokeLastWords(g, 10)).toBe(false);
  });

  it('首夜猎人被刀开枪：猎人和被带走的人都有遗言', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: 7 });
    g.ok(7, 'hunter_shoot', { target: 9 });
    expect(lastPublic(g, 'hunter.shot')?.text).toBe('7号开枪，9号出局。');
    g.toNight();
    expect(spokeLastWords(g, 7)).toBe(true);
    expect(spokeLastWords(g, 9)).toBe(true);
  });

  it('第 2 夜猎人被刀开枪：两人都没有遗言', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: null });
    g.toNight();
    g.night({ kill: 7 });
    g.ok(7, 'hunter_shoot', { target: 9 });
    g.toNight();
    expect(spokeLastWords(g, 7)).toBe(false);
    expect(spokeLastWords(g, 9)).toBe(false);
  });

  it('猎人被放逐开枪：两人都有遗言', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: null });
    g.toVote();
    g.vote({ 1: 7, 2: 7, 3: 7 });
    expect(lastPublic(g, 'exile')?.text).toBe('7号被投票放逐。');
    g.ok(7, 'hunter_shoot', { target: 9 });
    g.toNight();
    expect(spokeLastWords(g, 7)).toBe(true);
    expect(spokeLastWords(g, 9)).toBe(true);
  });

  it('猎人放弃开枪不公开任何信息（VIS-07）', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: 7 });
    const before = g.publicTexts().length;
    g.ok(7, 'hunter_shoot', { target: null });
    const added = g.publicTexts().slice(before);
    expect(added.some((t) => t.includes('猎人') || t.includes('开枪'))).toBe(false);
    expect(g.view(7).events.some((e) => e.type === 'hunter.decline')).toBe(true);
    expect(g.view(1).events.some((e) => e.type === 'hunter.decline')).toBe(false);
  });
});

describe('警长（DAY-05 ~ DAY-08）', () => {
  it('无人上警、全员上警、两轮平票都没有警长', () => {
    const none = new TestGame({ deal: DEAL12 });
    none.night({ kill: null });
    election(none, []);
    expect(lastPublic(none, 'sheriff.none')?.text).toBe('无人上警，本局没有警长。');

    const all = new TestGame({ deal: DEAL12 });
    all.night({ kill: null });
    election(all, Array.from({ length: 12 }, (_, i) => i + 1));
    expect(lastPublic(all, 'sheriff.none')?.text).toContain('全员上警');

    const tie = new TestGame({ deal: DEAL12 });
    tie.night({ kill: null });
    const split = { 1: 9, 2: 9, 3: 9, 4: 9, 5: 9, 6: 10, 7: 10, 8: 10, 11: 10, 12: 10 };
    election(tie, [9, 10], split);
    const pk = lastPublic(tie, 'vote.result');
    expect(pk?.text).toContain('平票，进入竞选 PK');
    expect(pk?.payload.seats).toEqual([9, 10]);
    expect(pk?.payload.outcome).toBe('pk');
    expect(tie.events.some((e) => e.type === 'sheriff.pk')).toBe(false);
    tie.until((x) => x.hasTool('sheriff_vote'));
    for (const s of tie.waiting()) tie.ok(s, 'sheriff_vote', { target: split[s as keyof typeof split] ?? null });
    const lost = lastPublic(tie, 'vote.result');
    expect(lost?.text).toContain('再次平票，警徽流失，本局没有警长。');
    expect(lost?.payload.outcome).toBe('lost');
    expect(tie.events.some((e) => e.type === 'sheriff.none')).toBe(false);
    expect(tie.state.sheriff).toBeNull();
  });

  it('放逐投票和警长选方向，都是先把法官的问话交给该听的人', () => {
    const vote = new TestGame({ deal: DEAL12, values: noSheriff });
    vote.night({ kill: null });
    vote.toVote();
    expect(lastPublic(vote, 'judge')?.text).toContain('请投票放逐一名玩家');

    const g = new TestGame({ deal: DEAL12 });
    g.night({ kill: null });
    election(g, [9, 10], everyone(9, [9, 10]));
    g.until((x) => x.hasTool('set_speak_direction'));
    const ask = [...g.events].reverse().find((e) => e.type === 'judge' && e.payload.step === 'day.discussion');
    expect(ask?.text).toContain('请选择发言方向');
    expect(ask?.audience).toEqual([9]);
    expect(g.view(1).events.some((e) => e.text.includes('请选择发言方向'))).toBe(false);
    expect(g.view(9).events.some((e) => e.text.includes('请选择发言方向'))).toBe(true);
  });

  it('警长票型与判定一次播出：当选不再另发一条', () => {
    const g = new TestGame({ deal: DEAL12 });
    g.night({ kill: null });
    election(g, [9, 10], everyone(9, [9, 10]));
    const result = lastPublic(g, 'vote.result');
    expect(result?.text).toMatch(/警长投票结果：.+9号当选警长。/);
    expect(result?.payload.outcome).toBe('elected');
    expect(g.events.some((e) => e.type === 'sheriff.elected')).toBe(false);
    expect(g.state.sheriff).toBe(9);
  });

  it('警长第一轮平票后，除平票台上的人以外都能投票', () => {
    const g = new TestGame({ deal: DEAL12 });
    g.night({ kill: null });
    election(g, [9, 10, 11], { 1: 9, 2: 9, 3: 9, 4: 9, 5: 10, 6: 10, 7: 10, 8: 10, 12: null });
    const pk = lastPublic(g, 'vote.result');
    expect(pk?.payload.seats).toEqual([9, 10]);
    expect(pk?.text).toContain('进入竞选 PK');
    expect(g.events.some((e) => e.type === 'sheriff.pk')).toBe(false);
    g.until((x) => x.hasTool('sheriff_vote'));
    expect(g.waiting()).not.toContain(9);
    expect(g.waiting()).not.toContain(10);
    expect(g.waiting()).toContain(11);
    expect(g.waiting()).toContain(1);
    expect(g.waiting()).toContain(12);
  });

  it('默认先竞选再公布死讯：首夜出局者可以当选，随后处理警徽并发表遗言', () => {
    const g = new TestGame({ deal: DEAL12 });
    g.night({ kill: 9 });
    election(g, [9, 10], everyone(9, [9, 10]));
    const publicEvents = g.events.filter((e) => e.audience === 'public');
    const electedAt = publicEvents.findIndex((e) => e.type === 'vote.result' && e.text.includes('当选警长'));
    const dawnAt = publicEvents.findIndex((e) => e.type === 'dawn');
    expect(electedAt).toBeGreaterThanOrEqual(0);
    expect(electedAt).toBeLessThan(dawnAt);
    expect(publicEvents.some((e) => e.type === 'sheriff.elected')).toBe(false);
    expect(g.hasTool('badge_dispose')).toBe(true);
    g.ok(9, 'badge_dispose', { target: 10 });
    expect(g.state.sheriff).toBe(10);
    expect(g.pending?.step.kind).toBe('lastwords');
    expect(g.pending?.actors).toEqual([9]);
  });

  it('先公布死讯再竞选时，首夜出局者不能上警', () => {
    const g = new TestGame({ deal: DEAL12, values: { 'sheriff.timing': 'after_last_words' } });
    g.night({ kill: 9 });
    g.until((x) => x.hasTool('sheriff_signup'));
    expect(g.waiting()).not.toContain(9);
    expect(spokeLastWords(g, 9)).toBe(true);
  });

  it('退水的玩家默认不能投票，开关打开后可以', () => {
    for (const canVote of [false, true]) {
      const g = new TestGame({ deal: DEAL12, values: { 'sheriff.withdrawnCanVote': canVote } });
      g.night({ kill: null });
      g.until((x) => x.hasTool('sheriff_signup'));
      for (const s of g.waiting()) g.ok(s, 'sheriff_signup', { run: [9, 10, 11].includes(s) });
      g.until((x) => x.pending?.step.kind === 'campaign' && x.pending.actors[0] === 11);
      g.ok(11, 'sheriff_withdraw', { content: '' });
      g.until((x) => x.hasTool('sheriff_vote'));
      expect(g.waiting().includes(11)).toBe(canVote);
      expect(g.waiting().includes(9)).toBe(false);
    }
  });

  it('警长夜里出局移交警徽，接任者当天放逐投票记 1.5 票（DAY-06）', () => {
    const g = new TestGame({ deal: DEAL12 });
    g.night({ kill: null });
    election(g, [9, 10], everyone(9, [9, 10]));
    g.toNight();
    g.night({ kill: 9 });
    g.ok(9, 'badge_dispose', { target: 10 });
    expect(lastPublic(g, 'badge.transfer')?.text).toBe('9号将警徽移交给10号。');
    g.toVote();
    g.vote({ 10: 1, 11: 2 });
    const ballots = lastPublic(g, 'vote.result')?.payload.ballots as { voter: Seat; weight: number }[];
    expect(ballots.find((b) => b.voter === 10)?.weight).toBe(1.5);
    expect(ballots.find((b) => b.voter === 11)?.weight).toBe(1);
    expect(lastPublic(g, 'exile')?.text).toBe('1号被投票放逐。');
  });

  it('警长被放逐：本轮 1.5 票照算，出局后先处理警徽再发表遗言（DAY-07）', () => {
    const g = new TestGame({ deal: DEAL12 });
    g.night({ kill: null });
    election(g, [9, 10], everyone(9, [9, 10]));
    g.toVote();
    g.vote({ 9: 10, 1: 9, 2: 9, 3: 9, 4: 9, 5: 10, 6: 10 });
    const result = lastPublic(g, 'vote.result')!;
    expect(result.text).toContain('10号 3.5 票');
    expect(result.text).toContain('9号(警长)');
    expect(lastPublic(g, 'exile')?.text).toBe('9号被投票放逐。');
    expect(g.hasTool('badge_dispose')).toBe(true);
    g.ok(9, 'badge_dispose', { target: null });
    expect(lastPublic(g, 'badge.tear')).toBeDefined();
    expect(g.pending?.step.kind).toBe('lastwords');
  });

  it('警长自爆：先处理警徽，再发表遗言，当天不再投票（DAY-08）', () => {
    const g = new TestGame({ deal: DEAL12 });
    g.night({ kill: null });
    election(g, [1]);
    expect(g.state.sheriff).toBe(1);
    g.until((x) => x.pending?.step.kind === 'discussion' && x.pending.actors[0] !== 1);
    expect(g.view(1).interrupts.map((t) => t.name)).toContain('wolf_explode');
    g.ok(1, 'wolf_explode', {});
    expect(lastPublic(g, 'explode')?.text).toBe('1号自爆出局。');
    expect(g.hasTool('badge_dispose')).toBe(true);
    g.ok(1, 'badge_dispose', { target: 5 });
    expect(g.pending?.step.kind).toBe('lastwords');
    expect(g.pending?.actors).toEqual([1]);
    g.auto(1);
    expect(g.state.phase).toBe('night');
    const day1 = g.events.filter((e) => e.type === 'vote.result');
    expect(day1).toHaveLength(0);
  });
});

describe('自爆（DAY-09）', () => {
  it('放逐投票期间不能自爆', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: null });
    g.toVote();
    expect(g.view(1).interrupts).toHaveLength(0);
    expect(g.act(1, 'wolf_explode', {})?.code).toBe('TOOL_NOT_LEGAL');
  });

  it('发言阶段随时可以自爆：打断当前发言，取消当天剩余发言和投票', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: null });
    g.until((x) => x.pending?.step.kind === 'discussion' && x.pending.actors[0] !== 2);
    const speaker = g.pending!.actors[0];
    g.ok(2, 'wolf_explode', {});
    expect(lastPublic(g, 'explode')?.payload.role).toBe('werewolf');
    expect(g.pending?.actors).toEqual([2]);
    expect(g.pending?.step.kind).toBe('lastwords');
    g.auto(2);
    expect(g.state.phase).toBe('night');
    expect(g.events.some((e) => e.type === 'speech' && e.payload.seat === speaker && e.payload.kind === 'discussion')).toBe(false);
  });

  it('每段发言前询问：多名狼人同时选择时座位号最小者自爆，其余人收到私密说明', () => {
    const g = new TestGame({ deal: DEAL12, values: { ...noSheriff, 'explode.window': 'between_speeches' } });
    g.night({ kill: null });
    g.untilTool('wolf_explode_decision');
    expect(g.waiting()).toEqual([1, 2, 3, 4]);
    g.ok(1, 'wolf_explode_decision', { explode: false });
    g.ok(2, 'wolf_explode_decision', { explode: false });
    g.ok(3, 'wolf_explode_decision', { explode: true });
    g.ok(4, 'wolf_explode_decision', { explode: true });
    expect(lastPublic(g, 'explode')?.text).toBe('3号自爆出局。');
    expect(g.view(4).events.some((e) => e.type === 'explode.preempted')).toBe(true);
    expect(g.view(1).events.some((e) => e.type === 'explode.preempted')).toBe(false);
  });

  it('旧规则可选择竞选中自爆警徽流失；旧延期模式第 2 天继续竞选', () => {
    const lost = new TestGame({ deal: DEAL12, values: { 'sheriff.explodeInElection': 'lost' } });
    lost.night({ kill: null });
    lost.until((x) => x.hasTool('sheriff_signup'));
    for (const s of lost.waiting()) lost.ok(s, 'sheriff_signup', { run: [1, 9, 10].includes(s) });
    lost.until((x) => x.pending?.step.kind === 'campaign');
    lost.ok(1, 'wolf_explode', {});
    expect(lastPublic(lost, 'sheriff.lost')).toBeDefined();
    lost.toNight();
    expect(lost.state.election.status).toBe('done');

    const later = new TestGame({ deal: DEAL12, values: { 'sheriff.explodeInElection': 'postpone' } });
    later.night({ kill: null });
    later.until((x) => x.hasTool('sheriff_signup'));
    for (const s of later.waiting()) later.ok(s, 'sheriff_signup', { run: [1, 9, 10].includes(s) });
    later.until((x) => x.pending?.step.kind === 'campaign');
    later.ok(1, 'wolf_explode', {});
    expect(lastPublic(later, 'sheriff.postponed')).toBeDefined();
    later.toNight();
    later.night({ kill: null });
    later.until((x) => x.hasTool('sheriff_vote'));
    expect(lastPublic(later, 'sheriff.resume')?.payload.candidates).toEqual([9, 10]);
  });
});

describe('非法行动（DAY-10 / VIS-10）', () => {
  it('平民调用查验或刀人被拒绝，拒绝只对本人可见', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    expect(g.act(9, 'seer_inspect', { target: 1 })?.code).toBe('NOT_YOUR_TURN');
    expect(g.act(9, 'wolf_kill', { target: 1 })?.code).toBe('NOT_YOUR_TURN');
    expect(g.view(9).events.filter((e) => e.type === 'action.rejected')).toHaveLength(2);
    expect(g.view(10).events.some((e) => e.type === 'action.rejected')).toBe(false);
    expect(g.spectator().events.some((e) => e.type === 'action.rejected')).toBe(false);
  });

  it('参数越界被拒绝；座位号和布尔的字符串写法按声明收下', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.until((x) => x.hasTool('wolf_kill'));
    expect(g.act(1, 'wolf_kill', { target: 13 })?.code).toBe('TARGET_NOT_IN_GAME');
    expect(g.act(1, 'wolf_kill', { target: '九号' })?.code).toBe('INVALID_ARGUMENT');
    expect(g.act(1, 'wolf_kill', { target: '9' })).toBeUndefined();
    expect(g.act(2, 'wolf_kill', { target: ' 10号 ' })).toBeUndefined();
    expect(g.act(3, 'wolf_kill', { target: '空刀' })).toBeUndefined();
    expect(g.act(4, 'wolf_kill', { target: 'null' })).toBeUndefined();

    const day = new TestGame({ deal: DEAL12, values: { ...noSheriff, 'explode.window': 'between_speeches' } });
    day.night({ kill: null });
    day.untilTool('wolf_explode_decision');
    day.ok(1, 'wolf_explode_decision', { explode: 'false' });
    day.ok(2, 'wolf_explode_decision', { explode: 'true' });
    day.ok(3, 'wolf_explode_decision', { explode: false });
    day.ok(4, 'wolf_explode_decision', { explode: '不自爆' });
    expect(lastPublic(day, 'explode')?.text).toBe('2号自爆出局。');
  });
});

describe('白痴（扩展身份示例）', () => {
  it('被放逐翻牌留场，失去投票权；再被放逐出局', () => {
    const deal = ['werewolf', 'werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'idiot', 'villager', 'villager', 'villager', 'villager'];
    const g = new TestGame({ preset: 'idiot12', deal, values: noSheriff });
    g.night({ kill: null });
    g.toVote();
    g.vote({ 1: 8, 2: 8 });
    expect(lastPublic(g, 'idiot.flip')).toBeDefined();
    expect(g.alive()).toContain(8);
    g.toNight();
    g.night({ kill: null });
    g.toVote();
    expect(g.waiting()).not.toContain(8);
    g.vote({ 1: 8, 2: 8 });
    expect(lastPublic(g, 'exile')?.text).toBe('8号被投票放逐。');
    expect(g.alive()).not.toContain(8);
  });
});
