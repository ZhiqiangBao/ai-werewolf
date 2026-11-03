import { describe, expect, it } from 'vitest';
import { assessAgainstClouds, assessAsrThreshold, compareAsrText, levenshtein } from '../../../scripts/video/asr-comparison';

describe('独立 ASR 定量比较', () => {
  it('英文按词保留 raw，并规范化大小写、标点、常见缩写及数词', () => {
    const c = compareAsrText("I'm player 10. I don't have 1.5 votes.", 'I am Player ten I do not have one point five votes', 'en');
    expect(c.unit).toBe('word'); expect(c.raw.edits).toBeGreaterThan(0); expect(c.normalized.edits).toBe(0);
    expect(c.normalized.referenceUnits).toBe(10);
  });
  it('不丢列表数字，也不把 1.5、15 或 1 混成同一值', () => {
    expect(compareAsrText('1, 2, 3.', 'one three', 'en').normalized.edits).toBe(1);
    expect(compareAsrText('1.5 votes', 'fifteen votes', 'en').normalized.edits).toBe(1);
    expect(compareAsrText('1.5 votes', 'one vote', 'en').normalized.edits).toBeGreaterThan(0);
    expect(compareAsrText('1, 2.', 'one two', 'en').normalized.edits).toBe(0);
  });
  it('中日按规范化字计算，数字改变和否定遗漏仍计错', () => {
    expect(compareAsrText('12号不投3号。', '十二号不投三号', 'zh-CN').normalized.edits).toBe(0);
    expect(compareAsrText('12号不投3号。', '十二号投三号', 'zh-CN').normalized.edits).toBe(1);
    expect(compareAsrText('11番は1番です。', '十一番は一番です', 'ja').normalized.edits).toBe(0);
    expect(compareAsrText('11番は1番です。', '十二番は一番です', 'ja').normalized.edits).toBeGreaterThan(0);
  });
  it('别名只能由调用方逐局提供，保留无别名分数', () => {
    const source = 'Vincentが警長でvote。', transcript = 'ヴィンセントが軽調でボート。';
    const c = compareAsrText(source, transcript, 'ja', [{ source: 'Vincent', transcript: 'ヴィンセント' }, { source: '警長', transcript: '軽調' }, { source: 'vote', transcript: 'ボート' }]);
    expect(c.normalized.edits).toBeGreaterThan(0); expect(c.withAliases.edits).toBe(0);
    expect(c.aliasesApplied.map((a) => a.occurrences)).toEqual([1, 1, 1]);
    expect(compareAsrText(source, transcript, 'ja').withAliases.edits).toBeGreaterThan(0);
  });
  it('数值门槛不能自动宣布质量等效', () => {
    const source = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const best = compareAsrText(source, source, 'en'), candidate = compareAsrText(source, source.replace('word50', 'different'), 'en');
    const result = assessAsrThreshold(candidate, best);
    expect(result.quantitativePass).toBe(true); expect(result.extraErrorsAllowed).toBe(2); // word50 分成词和数字，共200个单位
    expect(result.criticalReview).toBe('required'); expect(result.qualityEquivalent).toBe('not-determined');
    expect(result.criticalReviewAreas).toContain('negation');
    expect(assessAgainstClouds(candidate, [candidate, best])).toMatchObject({ bestCloudIndex: 1, bestCloudEdits: 0, qualityEquivalent: 'not-determined' });
    expect(levenshtein(['a', 'b'], ['a', 'c', 'b'])).toBe(1);
    expect(() => assessAsrThreshold(compareAsrText('same size', 'same size', 'en'), compareAsrText('other words', 'other words', 'en'))).toThrow(/same reference/);
  });
});
