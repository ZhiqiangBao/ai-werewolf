import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectGod } from '../../../packages/engine/src/index';
import { DEAL12, TestGame } from '../../../packages/engine/test/harness';
import { seatIdentity } from '../src/game-ui';
import { ToolForm } from '../src/components/TaskPanel';
import { I18nProvider } from '../src/i18n';

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
