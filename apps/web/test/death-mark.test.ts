import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEATH_GLYPHS, deathCauses, deathShortLabel, type DeathCause } from '@werewolf/protocol';
import { DeathMark } from '../src/components/DeathMark';

describe('出局图标的信息边界', () => {
  for (const locale of ['zh-CN', 'en', 'ja']) {
    it(`${locale} 玩家收到的所有夜间死因渲染为完全相同的图形、颜色和提示`, () => {
      const records = [['wolf'], ['poison'], ['guard_and_save'], ['wolf', 'poison'], ['unknown']];
      const html = records.map((causes) => renderToStaticMarkup(createElement(DeathMark, { causes: deathCauses('night', causes, false), locale })));
      expect(new Set(html).size).toBe(1);
      expect(html[0]).toContain('aria-label=');
      if (locale === 'zh-CN') expect(html[0]).toContain('title="夜晚出局"');
    });
  }
  it('上帝的狼刀与毒药有不同形象及明确短标签', () => {
    const wolf = renderToStaticMarkup(createElement(DeathMark, { causes: ['wolf'] }));
    const poison = renderToStaticMarkup(createElement(DeathMark, { causes: ['poison'] }));
    expect(wolf).toContain('狼刀'); expect(poison).toContain('毒药'); expect(wolf).not.toBe(poison);
  });
  it('英语短标签可放入座位图标，完整说明仍用于提示', () => {
    for (const cause of Object.keys(DEATH_GLYPHS) as DeathCause[]) {
      expect(deathShortLabel(cause, 'en').length).toBeLessThanOrEqual(6);
      expect(deathShortLabel(cause, 'en')).not.toMatch(/[\u4e00-\u9fff]/);
    }
    expect(renderToStaticMarkup(createElement(DeathMark, { causes: ['guard_and_save'], locale: 'en' }))).toContain('Protection and antidote collision');
  });
});
