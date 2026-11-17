import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectGod } from '../../../packages/engine/src/index';
import { DEAL12, TestGame } from '../../../packages/engine/test/harness';
import { seatIdentity } from '../src/game-ui';
import { ToolForm } from '../src/components/TaskPanel';
import { I18nProvider } from '../src/i18n';
import type { RoomBrief } from '@werewolf/protocol';
import { skillEffectForEvent } from '../../../packages/protocol/src/skill-effects';
import { replay as replayVideo } from '../../../scripts/video/replay';
import { buildHostedVideoScript } from '../src/video';

it('页面按角色视角展示身份，并按房间语言展示可选行动', () => {
  const game = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false } });
  game.night({ kill: null, inspect: 8 });
  const seer = game.view(5), spectator = game.spectator(), god = projectGod(game.state, game.events);
  expect(seatIdentity(seer, seer.seats[7], god.god.roles)).toMatchObject({ name: '好人', source: 'inspection' });
  expect(seatIdentity(seer, seer.seats[5], god.god.roles)).toEqual({});
  expect(spectator.seats.every((seat) => !seatIdentity(spectator, seat, god.god.roles).name)).toBe(true);
  vi.stubGlobal('localStorage', { getItem: () => 'ja' });
  try {
    const tool = { name: 'choose', title: 'Choose target', description: '', params: [{ name: 'target', label: 'Target', kind: 'seat' as const, options: [1, 2], nullable: true }] };
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(ToolForm, { tool, busy: true, locale: 'en', onSubmit: () => {} })));
    expect(html).toContain('Player 1');
    expect(html).toContain('送信中');
  } finally { vi.unstubAllGlobals(); }
});

it.each(['shoot', 'hold', 'hold-revealed', 'explode'])('狼王 %s 的亮牌及出局按实际事件进入座位牌和回放', (outcome) => {
  const deal = ['miracle_merchant', 'wolf_king', 'werewolf', 'villager', 'villager', 'villager'];
  const game = new TestGame({ preset: 'merchant12', deal, toolsetVersion: 2, values: {
    'sheriff.enabled': false, 'hunter.declineReveals': outcome === 'hold-revealed',
  } });
  game.ok(1, 'merchant_gift_inspect', { targetSeat: 4 });
  game.untilTool('lucky_inspect');
  game.ok(4, 'lucky_inspect', { targetSeat: 3 });
  if (outcome === 'explode') {
    game.until((g) => !!g.pending?.speechWindow);
    game.ok(2, 'wolf_explode');
  } else {
    game.untilTool('vote');
    for (const seat of game.waiting()) game.ok(seat, 'vote', { targetSeat: 2 });
    if (outcome === 'shoot') game.ok(2, 'wolf_king_shoot', { targetSeat: 5 });
    else game.ok(2, 'wolf_king_hold_fire');
  }
  const role = outcome === 'hold' ? undefined : 'wolf_king';
  for (const view of [game.view(4), game.spectator()]) {
    expect(seatIdentity(view, view.seats[1]).role).toBe(role);
  }
  const god = projectGod(game.state, game.events);
  const room: RoomBrief = { roomId: 'merchant', viewer: 'host', status: 'running', paused: false,
    presetName: god.presetName, seats: god.seats.map(({ seat, name }) => ({ seat, name, controller: 'human' })) };
  expect(() => buildHostedVideoScript(god, { ...room, viewer: 'spectator' })).toThrow();
  const script = buildHostedVideoScript(god, room);
  const night = script.chapters.find((chapter) => chapter.phase === 'night')!;
  expect(night.entries.find((entry) => entry.type === 'merchant.gift')).toMatchObject({ visibility: 'private',
    data: { target: 4, skill: 'seer', round: { roundKind: 'merchant', actionKind: 'gift', actorSeatId: 1, targetSeatId: 4 } } });
  expect(night.entries.find((entry) => entry.type === 'lucky.inspect')).toMatchObject({ visibility: 'private',
    data: { round: { roundKind: 'lucky', roundId: 'night-1-lucky-4', actorSeatId: 4, targetSeatId: 3 } } });
  expect(script.events.find((event) => event.type === 'merchant.gift.received')?.data).toEqual({ skill: 'seer', activeFromNight: 1 });
  const publicTape = { ...script, perspective: 'public', events: script.events.filter((event) => event.audience === 'public') };
  const terminalEvent = publicTape.events.find((event) => outcome === 'explode' ? event.type === 'explode'
    : outcome === 'shoot' ? event.type === 'wolf_king.shot' : event.type === 'wolf_king.decline');
  const state = replayVideo(publicTape, terminalEvent?.sourceSeq ?? Infinity);
  expect(state.revealed.get(2)).toBe(role);
  if (terminalEvent) expect(replayVideo(publicTape, terminalEvent.sourceSeq - 1).revealed.has(2)).toBe(false);
  if (outcome === 'shoot') {
    expect(state.alive.has(5)).toBe(false);
    expect(state.deaths.get(5)).toEqual(['shot']);
    const shot = game.events.find((event) => event.type === 'wolf_king.shot')!;
    expect(skillEffectForEvent(shot, { kind: 'spectator' }, shot.seq)).toMatchObject({ target: 5, kind: 'shot' });
  }
});
