import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { AVATAR_STYLES, gameText, type GameEvent } from '@werewolf/protocol';
import { EventLog } from '../src/components/EventLog';
import { ToolForm } from '../src/components/TaskPanel';
import { IdentityCard } from '../src/components/Cards';
import { VoteChart } from '../src/components/VoteChart';
import { I18nProvider, uiText } from '../src/i18n';
import { publicActivity, seatIdentity } from '../src/game-ui';
import { phaseLabel } from '../src/util';
import { DEAL12, TestGame } from '../../../packages/engine/test/harness';
import { Ctx, projectSpectator } from '../../../packages/engine/src/index';
import { daySteps, type SpeechKind } from '../../../packages/engine/src/flow/day';

const event = (seq: number, type: string, payload: Record<string, unknown>, text = '原始记录'): GameEvent => ({
  seq, type, payload, text, day: 1, phase: 'night', audience: [5],
});

describe('room language and personal interface language', () => {
  it.each(['zh-CN', 'en', 'ja'])('recognizes all five actual engine speech stages for %s', (locale) => {
    for (const kind of ['discussion', 'campaign', 'pk', 'sheriff_pk', 'lastwords'] as SpeechKind[]) {
      const game = new TestGame({ deal: DEAL12, values: { 'explode.enabled': false } });
      game.state.rules.locale = locale;
      game.state.phase = 'day'; game.state.day = 1; game.state.pending = null;
      game.state.election.candidates = [5];
      daySteps.speech.run(new Ctx(game.state), { type: 'speech', seat: 5, kind });
      const view = projectSpectator(game.state, []);
      expect(publicActivity(view, view.seats[4]), kind).toBe('speech');
    }
  });
  it('renders Japanese interface with English reconstructed records while retaining original player text', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'ja' });
    try {
      const speech = '狼人 {0} 原话';
      const events = [
        event(1, 'seer.result', { target: 8, result: 'good' }),
        event(2, 'witch.save', { target: 3 }),
        event(3, 'guard.protect', { target: 4 }),
        { ...event(4, 'speech', { seat: 2, content: speech }, speech), audience: 'public' as const },
        { ...event(5, 'legacy.custom', {}, '历史原话 {0}'), audience: 'public' as const },
      ];
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(EventLog, { events, seats: [], mode: 'seat', mySeat: 5, locale: 'en' })));
      expect(html).toContain('対局記録');
      expect(html).toMatch(/Seer/i);
      expect(html).toMatch(/Witch/i);
      expect(html).toMatch(/Guard/i);
      expect(html).toContain(speech);
      expect(html).toContain('历史原话 {0}');
      expect(html).not.toContain('预言家');
    } finally { vi.unstubAllGlobals(); }
  });

  it('localizes only an authorized alignment and keeps other identities private', () => {
    const game = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false } });
    game.night({ kill: null, inspect: 8 });
    const view = game.view(5);
    expect(seatIdentity(view, view.seats[7], undefined, 'en')).toMatchObject({ name: 'Good', source: 'inspection' });
    expect(seatIdentity(view, view.seats[5], undefined, 'en')).toEqual({});
    expect(seatIdentity({ ...view, viewer: { kind: 'spectator' } }, view.seats[7], undefined, 'en')).toEqual({});
  });
  it('uses the room language for action choices while the interface uses Japanese', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'ja' });
    try {
      const tool = { name: 'choose', title: 'Choose target', description: '', params: [{ name: 'target', label: 'Target', kind: 'seat' as const, options: [1, 2], nullable: true }] };
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(ToolForm, { tool, busy: true, locale: 'en', onSubmit: () => {} })));
      expect(html).toContain('Player 1');
      expect(html).toContain('送信中');
      expect(html).not.toContain('1号');
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([
    ['zh-CN', 'zh-CN', '预言家', '对局记录', '1号', '普通发言', '放逐投票', '1 票'],
    ['en', 'en', 'Seer', 'Game log', 'Player 1', 'Speech', 'Exile vote', '1 vote'],
    ['ja', 'ja', '占い師', '対局記録', '1番', '通常発言', '追放投票', '1票'],
    ['ja', 'en', 'Seer', '対局記録', 'Player 1', 'Speech', 'Exile vote', '1 vote'],
  ])('renders role, action, log and votes with UI %s and room %s', (ui, locale, role, log, seat, speechLabel, voteLabel, weight) => {
    vi.stubGlobal('localStorage', { getItem: () => ui });
    try {
      const game = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false } });
      game.state.rules.locale = locale;
      const view = game.view(5);
      const tool = { name: 'choose', title: gameText(locale, '选择发言方向'), description: '', params: [{ name: 'target', label: gameText(locale, '座位'), kind: 'seat' as const, options: [1], nullable: true }] };
      const vote = { ...event(2, 'vote.result', { kind: 'exile', round: 1, rows: [{ target: 1, weight: 1, voters: [2] }], ballots: [{ voter: 2, target: 1, weight: 1 }], abstain: [] }), audience: 'public' as const };
      const speech = { ...event(1, 'speech', { seat: 1, kind: 'discussion', content: '原话 {0}' }), audience: 'public' as const };
      const html = renderToStaticMarkup(createElement(I18nProvider, null,
        createElement(IdentityCard, { me: view.me!, catalog: null, locale }),
        createElement(ToolForm, { tool, busy: false, locale, onSubmit: () => {} }),
        createElement(EventLog, { events: [speech, vote], seats: [], mode: 'spectator', locale }),
        createElement(VoteChart, { event: vote, locale }),
      ));
      expect(html).toContain(role);
      expect(html).toContain(log);
      expect(html).toContain(seat);
      expect(html).toContain('原话 {0}');
      expect(html).toContain(speechLabel);
      expect(html).toContain(voteLabel);
      expect(html).toContain(weight);
      if (locale === 'en') expect(html).not.toContain('1 votes');
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(['en', 'ja'])('recognizes a localized public speech without marking badge actions as speech (%s)', (locale) => {
    const seat = { seat: 1, name: 'Alice', alive: true, sheriff: false, active: true };
    const seatLabel = gameText(locale, '{0}号', 1);
    const stage = gameText(locale, '{0}{1}中', seatLabel, gameText(locale, '竞选发言'));
    expect(publicActivity({ status: 'running', phase: 'day', stage, locale }, seat)).toBe('speech');
    expect(publicActivity({ status: 'running', phase: 'day', stage: gameText(locale, '{0}处理警徽', seatLabel), locale }, seat)).toBe('action');
  });
  it('keeps a day-zero end event in the end phase', () => {
    expect(phaseLabel(0, 'end', 'en')).toBe(gameText('en', '终局'));
  });
  it.each(['en', 'ja'])('translates every dynamic avatar style name for %s interface', (locale) => {
    expect(AVATAR_STYLES.map((style) => uiText(locale, style.name))).toEqual(locale === 'en'
      ? ['Storybook', 'Japanese school', 'Traditional Chinese', 'Swords and magic', 'Modern city', 'Future technology']
      : ['絵本', '日本の学園', '中国古風', '剣と魔法', '現代都市', '未来技術']);
  });
});
