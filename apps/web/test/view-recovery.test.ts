import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { retainView, ViewLoader } from '../src/view-loader';
import { I18nProvider } from '../src/i18n';
import { WatchPage } from '../src/pages/Game';

const view = vi.hoisted(() => ({ data: null as unknown, error: null as string | null }));
vi.mock('../src/hooks', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/hooks')>(), useView: () => view }));

it('刷新失败保留原视图并在恢复时清除错误', async () => {
  const snapshots: { data: string | null; error: string | null }[] = [];
  let attempt = 0, current: string | null = null;
  const loader = new ViewLoader(async () => {
    if (++attempt === 2) throw new Error('offline');
    return `view ${attempt}`;
  }, (data, error) => { current = retainView(current, data); snapshots.push({ data: current, error }); }, () => true);
  loader.activate();
  await loader.refresh(); await loader.refresh(); await loader.refresh();
  expect(snapshots).toEqual([{ data: 'view 1', error: null }, { data: 'view 1', error: 'offline' }, { data: 'view 3', error: null }]);
});

it.each(['host', 'seat'])('观战页面阻止 %s 凭证的投影', (viewer) => {
  vi.stubGlobal('localStorage', { getItem: () => 'zh-CN' });
  view.data = { room: { viewer }, projection: { events: [{ text: 'SECRET' }] } };
  try {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(WatchPage, { roomId: 'room', token: 'token' })));
    expect(html).toContain('这个链接不是观战链接');
    expect(html).not.toContain('SECRET');
  } finally { vi.unstubAllGlobals(); }
});
