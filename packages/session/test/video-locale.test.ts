import { expect, it } from 'vitest';
import { allRoleRules } from '../../../scripts/video/rule-cards';
import { speakerIdentity } from '../../../scripts/video/speaker';
import { buildClips, type Script, type TimedClip } from '../../../scripts/video/project';
import { registerVideoLanguage, videoChapter, videoLocale, videoText } from '../../../scripts/video/video-locale';
import { DEATH_GLYPHS } from '../../protocol/src/death-glyphs';

const script: Script = {
  locale: 'zh-CN', roomId: 'synthetic', perspective: 'god', presetName: '测试版型', status: 'ended',
  ruleCard: '· 普通狼人：本局原始规则，不能改写。\n· 警徽：原始警徽规则。',
  cast: [{ seat: 1, name: '原名', role: 'werewolf', roleName: '狼人', factionName: '狼人', voiceKey: 'seat-1' }], events: [],
  chapters: [{ day: 2, phase: 'night', title: '旧章节原文', entries: [{ sourceSeq: 1, type: 'speech', speaker: '1', seat: 1, voiceKey: 'seat-1', text: '我投给2号，原话不翻译。', visibility: 'public', data: {} }] }], result: null,
};

it('按结构化昼夜与目标语言显示标题和全部死因短标签', () => {
  expect(videoChapter('en', 2, 'night', '不要解析')).toBe('Night 2');
  expect(videoChapter('en', 3, 'day', '不要解析')).toBe('Day 3');
  expect(videoChapter('ja', 2, 'night', '不要解析')).toBe('2夜目');
  expect(videoChapter('ja', 3, 'day', '不要解析')).toBe('3日目');
  for (const glyph of Object.values(DEATH_GLYPHS)) {
    expect(videoText('en', glyph.shortLabel)).not.toBe(glyph.shortLabel);
    expect(videoText('ja', glyph.shortLabel)).not.toBe('');
    expect(videoText('en', glyph.shortLabel).length).toBeLessThanOrEqual(6);
  }
  expect(videoText('en', '月影议事厅')).toBe('Moonshadow Hall');
  expect(videoText('ja', '本局技能卡')).toBe('対局の能力カード');
});

it('覆盖只改变画面标签，不翻译玩家原话或原始规则正文', () => {
  const clips = buildClips(script);
  const original = script.chapters[0].entries[0].text;
  expect(clips[0].text).toBe(original);
  expect(speakerIdentity(script, clips[0], 'en')).toMatchObject({ title: 'Seat 1 · Werewolf', name: '原名' });
  expect(allRoleRules(script, 'en')[0]).toMatchObject({ title: 'Werewolf · 1 players', text: '本局原始规则，不能改写。' });
  expect(allRoleRules(script, 'ja')[0]).toMatchObject({ title: '人狼 · 1人', text: '本局原始规则，不能改写。' });
  expect(script.chapters[0].entries[0].text).toBe(original);
});

it('未知语言明确报错，注册扩展语言可继承并覆盖模板', () => {
  expect(videoLocale(undefined, '')).toBe('zh-CN');
  expect(() => videoLocale('xx-XX', '')).toThrow('Unsupported video language');
  registerVideoLanguage({ id: 'en-GB', fallback: 'en', messages: { '第{0}天': 'Day number {0}' } });
  expect(videoLocale('zh-CN', 'en-GB')).toBe('en-GB');
  expect(videoChapter('en-GB', 4, 'day', '')).toBe('Day number 4');
  expect(videoText('en-GB', '月影议事厅')).toBe('Moonshadow Hall');
  expect(videoText('en', 'toString')).toBe('toString');
  expect(videoText('en', '第{0}天', '{1}')).toBe('Day {1}');
  expect(() => registerVideoLanguage({ id: 'fr', fallback: 'en', messages: { '第{0}天': 'jour' } })).toThrow('translation');
});

it('离线渲染合成帧不会改写台词或调用配音', async () => {
  const { createSceneRenderer } = await import('../../../scripts/video/scene');
  const clip = { ...buildClips(script)[0], frames: 30, startFrame: 0, audioDuration: 1, audioMeta: {}, captions: [], envelope: [] } as unknown as TimedClip;
  const previous = process.env.VIDEO_LOCALE;
  try {
    const frames: Buffer[] = [];
    for (const locale of ['en', 'ja']) {
      process.env.VIDEO_LOCALE = locale;
      const draw = await createSceneRenderer(script);
      frames.push(await draw(clip));
      expect(frames.at(-1)!.byteLength).toBeGreaterThan(1000);
    }
    expect(frames[0].equals(frames[1])).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.VIDEO_LOCALE; else process.env.VIDEO_LOCALE = previous;
  }
  expect(clip.text).toBe('我投给2号，原话不翻译。');
});
