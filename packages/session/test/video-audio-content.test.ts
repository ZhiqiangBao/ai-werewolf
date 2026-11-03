import { describe, expect, it } from 'vitest';
import { assertAudioContentReview, reviewAudioContent } from '../../../scripts/video/audio-content-review';
import { sourceCaptionWords } from '../../../scripts/video/timeline';
import type { AudioMeta } from '../../../scripts/video/qwen';

describe('独立音频内容核对', () => {
  const audio = Buffer.from('synthetic audio bytes, not actual speech');
  const sourceText = '3番Vincentです。私は立候補します。';
  const aliases = [{ source: 'Vincent', transcript: 'ビンセント' }];
  const transcript = '三番ビンセントです、私は立候補します。';
  const input = { audio, sourceText, transcript, locale: 'ja', aliases };
  it('even matching provider labels do not validate an instruction spoken before the source', () => {
    const metadata = { text: sourceText, sentences: [{ index: 0, text: sourceText,
      words: [{ text: sourceText, begin_time: 0, end_time: 2000 }] }] } as AudioMeta;
    expect(sourceCaptionWords(metadata, 'ja').map((word) => word.text).join('')).toBe(sourceText);
    const bad = { ...input, transcript: '指定された原文だけを読み、言葉を追加しない。' + transcript };
    expect(reviewAudioContent(bad).matches).toBe(false);
    expect(() => assertAudioContentReview(reviewAudioContent(bad), bad)).toThrow(/does not match source/);
  });
  it('only accepts explicitly supplied name aliases, punctuation and numeric equivalence', () => {
    expect(reviewAudioContent({ ...input, aliases: [] }).matches).toBe(false);
    const review = reviewAudioContent(input);
    expect(review.matches).toBe(true);
    expect(() => assertAudioContentReview(review, input)).not.toThrow();
    expect(() => reviewAudioContent({ ...input, aliases: [{ source: 'Unknown', transcript: 'ビンセント' }] })).toThrow(/Alias must occur/);
  });
  it('rejects omissions, repetition and changed numbers even with valid timestamps', () => {
    for (const actual of ['三番ビンセントです。', transcript + '私は立候補します。', '四番ビンセントです。私は立候補します。']) {
      expect(reviewAudioContent({ ...input, transcript: actual }).matches).toBe(false);
    }
  });
  it('binds audio, source, independent transcript and alias choices to the review', () => {
    const review = reviewAudioContent(input);
    expect(() => assertAudioContentReview(review, { ...input, audio: Buffer.from('different bytes') })).toThrow(/does not match current audio/);
    expect(() => assertAudioContentReview(review, { ...input, transcript: transcript + '余分' })).toThrow(/does not match current audio/);
    expect(() => assertAudioContentReview(review, { ...input, aliases: [] })).toThrow(/does not match current audio/);
  });
  it('permits deterministic numeric readings without accepting different values', () => {
    const en = { audio, locale: 'en', sourceText: 'Player 10 has 1.5 votes.', transcript: 'Player ten has one point five votes.' };
    expect(reviewAudioContent(en).matches).toBe(true);
    expect(reviewAudioContent({ ...en, transcript: 'Player nine has one point five votes.' }).matches).toBe(false);
    expect(reviewAudioContent({ audio, locale: 'zh-CN', sourceText: '12号投给3号。', transcript: '十二号投给三号' }).matches).toBe(true);
  });
  it('preserves unsupported decimals and number signs instead of collapsing distinct values', () => {
    const matches = (sourceText: string, transcript: string, locale = 'en') => reviewAudioContent({ audio, locale, sourceText, transcript }).matches;
    expect(matches('Take 1.2345 votes', 'Take 12345 votes')).toBe(false);
    expect(matches('Take 123.45 votes', 'Take 12345 votes')).toBe(false);
    expect(matches('Take 123.45 votes', 'Take 123.45 votes')).toBe(true);
    expect(matches('Take 1.2345 votes', 'Take 1.2345 votes')).toBe(true);
    expect(matches('Change -1.5 votes', 'Change 1.5 votes')).toBe(false);
    expect(matches('Change -1.5 votes', 'Change +1.5 votes')).toBe(false);
    expect(matches('Change −1.5 votes', 'Change minus one point five votes')).toBe(true);
    expect(matches('Score -1', 'Score 1')).toBe(false);
    expect(matches('残高 -12', '残高 12', 'ja')).toBe(false);
    expect(matches('100.5点', '1005点', 'ja')).toBe(false);
    expect(matches('1.5-vote', 'one point five vote')).toBe(true);
    expect(matches('11番', '十一番', 'ja')).toBe(true);
  });
});
