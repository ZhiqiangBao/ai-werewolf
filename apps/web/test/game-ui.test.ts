import { describe, expect, it } from 'vitest';
import type { GameEvent, SeatInfo } from '@werewolf/protocol';
import { publicActivity, publicElection, seatIdentity } from '../src/game-ui';
import { DEAL12, TestGame } from '../../../packages/engine/test/harness';
import { projectGod } from '../../../packages/engine/src/index';

const event = (type: string, payload: Record<string, unknown> = {}, audience: GameEvent['audience'] = 'public'): GameEvent => ({ seq: 1, day: 1, phase: 'day', type, payload, audience, text: '' });
const actor: SeatInfo = { seat: 1, name: '1号', alive: true, sheriff: true, active: true };

describe('按实际知情范围显示身份', () => {
  const game = () => {
    const g = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false } });
    g.night({ kill: null, inspect: 8 });
    return g;
  };
  it('上帝看全身份，普通玩家看本人，观战看不到私密角标', () => {
    const g = game(), god = projectGod(g.state, g.events), player = g.view(9), watch = g.spectator();
    expect(god.seats.every((s) => !!seatIdentity(god, s, god.god.roles).role)).toBe(true);
    expect(player.seats.filter((s) => !!seatIdentity(player, s, god.god.roles).name).map((s) => s.seat)).toEqual([9]);
    expect(watch.seats.every((s) => !seatIdentity(watch, s, god.god.roles).name)).toBe(true);
  });
  it('狼人仅互认已获准知道的队友，不获得其他玩家身份', () => {
    const view = game().view(1);
    expect(view.seats.filter((s) => !!seatIdentity(view, s).name).map((s) => s.seat)).toEqual([1, 2, 3, 4]);
    expect(seatIdentity(view, view.seats[1])).toMatchObject({ name: '狼人', source: 'teammate' });
    expect(seatIdentity(view, view.seats[4])).toEqual({});
  });
  it('预言家查验守卫后只见好人，不从上帝数据反推神职', () => {
    const g = game(), view = g.view(5), god = projectGod(g.state, g.events);
    expect(seatIdentity(view, view.seats[7], god.god.roles)).toEqual({ name: '好人', tone: 'villager', source: 'inspection' });
    expect(seatIdentity(view, view.seats[5], god.god.roles)).toEqual({});
    expect(seatIdentity(view, view.seats[4])).toMatchObject({ role: 'seer', name: '预言家', source: 'self' });
  });
  it('旧服务器的查验也只读取发给本人的私密结果，忽略公开声称与他人结果', () => {
    const view = game().view(5);
    delete view.me!.knownIdentities;
    expect(seatIdentity(view, view.seats[7]).name).toBe('好人');
    view.events = [event('seer.result', { target: 8, result: 'wolf' }), event('seer.result', { target: 8, result: 'wolf' }, [6])];
    expect(seatIdentity(view, view.seats[7])).toEqual({});
  });
  it('公开翻牌字段和错误传入的上帝列表不会让玩家看到未获准身份', () => {
    const g = game(), view = g.view(9), god = projectGod(g.state, g.events);
    const target = { ...view.seats[5], revealedRole: 'witch', revealedRoleName: '女巫' };
    expect(seatIdentity(view, target, god.god.roles)).toEqual({});
    expect(seatIdentity({ ...view, viewer: { kind: 'spectator' } }, target, god.god.roles)).toEqual({});
  });
  it('具体身份查验通过明确的私密知情记录扩展，其他视角不继承', () => {
    const view = game().view(5);
    view.me!.knownIdentities = [{ seat: 6, kind: 'role', role: 'witch', roleName: '女巫', source: 'inspection' }];
    expect(seatIdentity(view, view.seats[5])).toEqual({ role: 'witch', name: '女巫', source: 'inspection' });
    expect(seatIdentity({ ...view, viewer: { kind: 'spectator' } }, view.seats[5])).toEqual({});
  });
  it('公开技能只显示已宣布的表面身份；私密旧查验不覆盖公开翻牌', () => {
    const view = game().view(5);
    const target = { ...view.seats[5], revealedRole: 'hunter', revealedRoleName: '猎人' };
    view.me!.knownIdentities = [{ seat: 6, kind: 'role', role: 'witch', roleName: '女巫', source: 'inspection' }];
    view.events.push(event('hunter.shot', { shooter: 6, target: 9, role: 'hunter' }));
    expect(seatIdentity(view, target)).toEqual({ role: 'hunter', name: '猎人', source: 'public' });
    expect(seatIdentity({ ...view, viewer: { kind: 'spectator' } }, target)).toEqual({ role: 'hunter', name: '猎人', source: 'public' });
  });
  it('正常终局可显示复盘底牌，流局不凭空揭示身份', () => {
    const g = game(); g.until((x) => !!x.state.result);
    const watch = g.spectator();
    expect(watch.seats.every((s) => seatIdentity(watch, s).role === s.revealedRole)).toBe(true);
    const target = { ...watch.seats[5], revealedRole: 'witch', revealedRoleName: '女巫' };
    expect(seatIdentity({ ...watch, events: [] }, target)).toEqual({});
  });
});

describe('公开座位状态', () => {
  it('上帝视角的私密事件不能提前点亮上警标记', () => {
    const state = publicElection([event('sheriff.start'), event('sheriff.signup', { candidates: [1, 2] }, []), event('sheriff.signup', { candidates: [3] }, [3])]);
    expect([...state.candidates]).toEqual([]);
  });
  it('只归纳已公开候选人，并保留退水区别', () => {
    const state = publicElection([event('sheriff.start'), event('sheriff.signup', { candidates: [1, 2, 3] }), event('sheriff.withdraw', { seat: 2 })]);
    expect(state.phase).toBe('running');
    expect([...state.candidates].filter((s) => !state.withdrawn.has(s))).toEqual([1, 3]);
    expect([...state.withdrawn]).toEqual([2]);
  });
  it.each(['sheriff.none', 'sheriff.elected', 'sheriff.lost', 'game.end'])('%s 后不再显示竞选中的旗标', (type) => {
    expect(publicElection([event('sheriff.signup', { candidates: [1, 2] }), event(type)]).phase).toBe('closed');
  });
  it.each(['elected', 'lost'])('真实票型事件 outcome=%s 后关闭竞选', (outcome) => {
    expect(publicElection([event('sheriff.signup', { candidates: [1, 2] }), event('vote.result', { kind: 'sheriff', outcome })]).phase).toBe('closed');
  });
  it('警长 PK 只保留平票候选人，放逐票型不改变竞选', () => {
    const state = publicElection([event('sheriff.signup', { candidates: [1, 2, 3] }), event('vote.result', { kind: 'sheriff', outcome: 'pk', seats: [1, 3] }), event('vote.result', { kind: 'exile', outcome: 'lost' })]);
    expect([...state.candidates]).toEqual([1, 3]);
    expect(state.phase).toBe('running');
  });
  it('延期隐藏活动旗标，恢复时使用新公开的候选名单', () => {
    const initial = [event('sheriff.signup', { candidates: [1, 2, 3] }), event('sheriff.withdraw', { seat: 2 }), event('sheriff.postponed')];
    expect(publicElection(initial).phase).toBe('postponed');
    const state = publicElection([...initial, event('sheriff.resume', { candidates: [1, 3] })]);
    expect(state.phase).toBe('running');
    expect([...state.candidates]).toEqual([1, 3]);
    expect(state.withdrawn.size).toBe(0);
  });
  it('新竞选清除旧旗标与退水状态', () => {
    const state = publicElection([event('sheriff.signup', { candidates: [1, 2] }), event('sheriff.withdraw', { seat: 2 }), event('sheriff.start')]);
    expect(state.candidates.size).toBe(0);
    expect(state.withdrawn.size).toBe(0);
  });
  it.each(['1号发言中', '1号竞选发言中', '1号竞选PK发言中', '1号遗言中'])('%s 显示发言状态', (stage) => {
    expect(publicActivity({ status: 'running', phase: 'day', stage }, actor)).toBe('speech');
  });
  it.each(['警长1号选择发言方向', '1号处理警徽'])('%s 不会被误标为正在发言', (stage) => {
    expect(publicActivity({ status: 'running', phase: 'day', stage }, actor)).toBe('action');
  });
  it('夜间、终局和非公开行动座位不会点亮发言提示', () => {
    expect(publicActivity({ status: 'running', phase: 'night', stage: '1号发言中' }, actor)).toBeNull();
    expect(publicActivity({ status: 'ended', phase: 'day', stage: '1号发言中' }, actor)).toBeNull();
    expect(publicActivity({ status: 'running', phase: 'day', stage: '1号发言中' }, { ...actor, active: false })).toBeNull();
  });
});
