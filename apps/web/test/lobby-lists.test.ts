import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelPresetView } from '@werewolf/protocol';
import { ModelList } from '../src/components/ModelList';
import { RecentRooms } from '../src/components/RecentRooms';
import { paginate, Pagination } from '../src/components/Pagination';

afterEach(() => vi.unstubAllGlobals());

describe('大厅列表折叠和分页', () => {
  it('模型数再多也默认折叠，不渲染模型条目', () => {
    const models = Array.from({ length: 20 }, (_, i) => ({ id: `model-${i}`, label: `MODEL_LABEL_${i}`, baseUrl: 'https://example.invalid/v1', model: `model-${i}`, source: 'added', hasKey: true })) as ModelPresetView[];
    const html = renderToStaticMarkup(createElement(ModelList, { models, onRemove: async () => {} }));
    expect(html).toContain('展开模型库');
    expect(html).toContain('20 个模型');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('MODEL_LABEL_');
    expect(html).not.toContain('class="model-item"');
  });

  it('无论本机记录的排列顺序如何，只展示最新四场房间', () => {
    const rooms = Array.from({ length: 20 }, (_, i) => ({ roomId: `council-${String(i + 1).padStart(2, '0')}`, hostToken: `synthetic-${i}`, createdAt: i * 1000 }));
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(rooms) });
    const html = renderToStaticMarkup(createElement(RecentRooms, { busy: false, onCreate: () => {} }));
    const titles = [...html.matchAll(/<h3>房间 (.*?)<\/h3>/g)].map((match) => match[1]);
    expect(titles).toEqual(['council-20', 'council-19', 'council-18', 'council-17']);
    expect(html).toContain('展开更早的房间');
    expect(html).toContain('16 场');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('synthetic-');
  });

  it('不满五场时不提供历史展开按钮，空列表仍可创建房间', () => {
    vi.stubGlobal('localStorage', { getItem: () => '[]' });
    const html = renderToStaticMarkup(createElement(RecentRooms, { busy: false, onCreate: () => {} }));
    expect(html).toContain('创建房间');
    expect(html).not.toContain('更早的房间');
  });

  it('翻页无重复或遗漏，末页删除后退回有效页，空列表无分页按钮', () => {
    const values = Array.from({ length: 17 }, (_, i) => i);
    expect([1, 2, 3].flatMap((page) => paginate(values, page, 8).items)).toEqual(values);
    expect(paginate(values, 3, 8)).toMatchObject({ page: 3, pageCount: 3, items: [16] });
    expect(paginate(values.slice(0, 16), 3, 8)).toMatchObject({ page: 2, pageCount: 2, items: values.slice(8, 16) });
    expect(paginate([], 3, 8)).toMatchObject({ page: 1, pageCount: 1, items: [] });
    expect(renderToStaticMarkup(createElement(Pagination, { label: '模型库', page: 1, pageCount: 1, onChange: () => {} }))).toBe('');
  });
});
