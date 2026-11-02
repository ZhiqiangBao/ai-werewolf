import { expect, it, vi } from 'vitest';
import { completeHosting } from '../../../scripts/video/hosting';
import { assertPlayerSources } from '../../../scripts/video/integrity';
import { buildClips, splitSpeech, type Fact, type Script } from '../../../scripts/video/project';

function fixture(locale: string): Script {
  const rows: [string, Record<string, unknown>, number[] | 'public'][] = [
    ['phase', {}, 'public'], ['guard.protect', { target: 2 }, [1]], ['guard.skip', {}, [1]],
    ['wolf.chat', { content: 'Original wolf speech 42.' }, [1]], ['wolf.kill.result', { knife: 2 }, 'public'], ['wolf.kill.result', { knife: null }, 'public'],
    ['seer.result', { target: 2, result: 'wolf' }, [1]], ['seer.skip', {}, [1]],
    ['witch.knife', { knife: 2 }, [1]], ['witch.knife', { knife: null }, [1]],
    ['witch.save', { target: 2 }, [1]], ['witch.poison', { target: 3 }, [1]], ['witch.idle', {}, [1]],
    ['sheriff.start', {}, 'public'], ['sheriff.signup', { candidates: [1, 2] }, 'public'], ['sheriff.order', { direction: 'counterclockwise', order: [2, 1] }, 'public'],
    ['vote.result', { kind: 'sheriff', outcome: 'elected', seat: 1, rows: [{ target: 1, weight: 2 }], abstain: [3], conclusion: 'Original conclusion.' }, 'public'],
    ['speech.order', { direction: 'clockwise', order: [2, 1] }, 'public'],
    ['vote.result', { kind: 'exile', round: 2, rows: [], conclusion: 'Original conclusion.' }, 'public'],
    ['speech', { content: 'Original player speech 42.' }, 'public'],
  ];
  const events: Fact[] = rows.map(([type, data, audience], i) => ({ sourceSeq: i + 1, day: 1, phase: 'day', type, data, audience, spoken: true, text: 'Original event.' }));
  const entries = events.map((e) => ({ sourceSeq: e.sourceSeq, type: e.type, speaker: 'fixture', voiceKey: e.type === 'speech' || e.type === 'wolf.chat' ? 'seat-1' : 'judge',
    ...(e.type === 'speech' || e.type === 'wolf.chat' ? { seat: 1 } : {}), text: e.type === 'speech' ? 'Original player speech 42.' : e.type === 'wolf.chat' ? 'Original wolf speech 42.' : e.text, visibility: 'public', data: e.data }));
  return { locale, roomId: 'fixture', perspective: 'god', presetName: '', status: 'ended', result: null,
    cast: [1, 2, 3].map((seat) => ({ seat, name: String(seat), role: 'villager', roleName: 'Villager', factionName: 'Good', voiceKey: `seat-${seat}` })),
    events, chapters: [{ day: 1, phase: 'day', title: 'Day 1', entries }] };
}

it.each(['en', 'ja'])('%s 主持衔接按原局语言生成，画面语言不影响原话和校验', (locale) => {
  vi.stubEnv('VIDEO_LOCALE', locale === 'en' ? 'ja' : 'en');
  try {
    const source = fixture(locale), before = structuredClone(source);
    const hosted = completeHosting(source, source);
    expect(source).toEqual(before);
    expect(hosted.events).toEqual(before.events);
    const entries = hosted.chapters[0].entries;
    expect(entries.find((e) => e.type === 'speech')?.text).toBe('Original player speech 42.');
    expect(entries.find((e) => e.type === 'wolf.chat')?.text).toBe('Original wolf speech 42.');
    expect(entries.some((e) => e.text.includes('Original conclusion.'))).toBe(true);
    const generated = entries.filter((e) => e.type !== 'speech' && e.type !== 'wolf.chat').map((e) => e.text).join('\n');
    if (locale === 'en') {
      expect(generated).not.toMatch(/[\u3400-\u9fff]/);
      expect(generated).toContain('I protect seat 2.');
      expect(generated).toContain('counterclockwise');
      expect(generated).toContain('seat 1: 2 votes');
    } else {
      expect(generated).toContain('2番を護衛します。');
      expect(generated).toContain('反時計回り');
      expect(generated).toContain('1番2票');
      expect(generated).not.toContain('请睁眼');
    }
    const clips = buildClips(hosted);
    expect(() => assertPlayerSources(source, hosted, clips)).not.toThrow();
    const choice = clips.find((c) => c.data.presentationKey === 'guard-choice')!;
    const forged = clips.map((c) => c === choice ? { ...c, text: 'Forged', spokenText: 'Forged' } : c);
    expect(() => assertPlayerSources(source, hosted, forged)).toThrow('unrecorded speech');
  } finally { vi.unstubAllEnvs(); }
});

it('英文长发言优先在单词间切分，中文分段规则保持不变', () => {
  const english = 'Thoughtful players compare every vote before deciding. '.repeat(20).trim();
  const parts = splitSpeech(english, 80, 'en');
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every((part) => part.length <= 80)).toBe(true);
  expect(parts.join(' ')).toBe(english);
  expect(parts.every((part) => !part.startsWith('houghtful'))).toBe(true);
  const chinese = '十号发言，警徽流和票型都应该一起看。'.repeat(20);
  expect(splitSpeech(chinese, 80, 'zh-CN')).toEqual(splitSpeech(chinese, 80));
});
