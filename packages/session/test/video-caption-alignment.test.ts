import { describe, expect, it } from 'vitest';
import { captionsFromWords, sourceCaptionWords } from '../../../scripts/video/timeline';
import type { AudioMeta } from '../../../scripts/video/qwen';
import { videoAudioLanguage } from '../../../scripts/video/video-locale';

const meta = (text: string, words: { text: string; begin_time: number; end_time: number }[]) =>
  ({ text, sentences: [{ index: 0, text, words }] }) as AudioMeta;

describe('multilingual source captions', () => {
  it('maps English seat numbers and a decimal to the actual provider boundaries', () => {
    const labels = ['Night', ' one', ', Player', ' three', ', One', ' point', ' five', ' vote', ', Player', ' eight', ' or', ' Player', ' ten'];
    const source = meta('Night 1, Player 3, 1.5-vote, Player 8 or Player 10.', labels.map((text, i) => ({ text, begin_time: i * 200, end_time: (i + 1) * 200 })));
    const words = sourceCaptionWords(source, 'en');
    expect(words.map((word) => word.text).join('')).toBe(source.text);
    expect(words.find((word) => word.text.includes('1.5'))).toMatchObject({ begin_time: 800, end_time: 1400 });
    expect(words.find((word) => word.text.includes('10'))).toMatchObject({ begin_time: 2400, end_time: 2600 });
    expect(captionsFromWords(source, 3, 'en').map((cue) => cue.text).join('')).toBe(source.text);
  });
  it('preserves a reduced English real-word timestamp example, including the decimal as a single source span', () => {
    const source = meta('1.5-vote badge is exactly what I want to stop.', [
      { text: 'One', begin_time: 320, end_time: 640 }, { text: ' point', begin_time: 640, end_time: 960 },
      { text: ' five', begin_time: 960, end_time: 1280 }, { text: ' vote', begin_time: 1280, end_time: 1600 },
      { text: ' badge', begin_time: 1600, end_time: 2000 }, { text: ' is', begin_time: 2000, end_time: 2240 },
      { text: ' exactly', begin_time: 2320, end_time: 2880 }, { text: ' what', begin_time: 2880, end_time: 3040 },
      { text: ' I', begin_time: 3040, end_time: 3120 }, { text: ' want', begin_time: 3120, end_time: 3360 },
      { text: ' to', begin_time: 3360, end_time: 3520 }, { text: ' stop', begin_time: 3520, end_time: 3840 },
    ]);
    const words = sourceCaptionWords(source, 'en');
    expect(words[0]).toMatchObject({ text: '1.5', begin_time: 320, end_time: 1280 });
    expect(words.map((word) => word.text).join('')).toBe(source.text);
  });
  it('maps Japanese decimal digits to Kanji without splitting a number over estimated times', () => {
    const source = meta('10番、12番、1番。', [
      { text: '十', begin_time: 0, end_time: 324 }, { text: '番', begin_time: 324, end_time: 647 },
      { text: '十', begin_time: 700, end_time: 1000 }, { text: '二', begin_time: 1000, end_time: 1300 },
      { text: '番', begin_time: 1300, end_time: 1500 }, { text: '一', begin_time: 1600, end_time: 1800 },
      { text: '番', begin_time: 1800, end_time: 2000 },
    ]);
    const words = sourceCaptionWords(source, 'ja');
    expect(words.map((word) => word.text).join('')).toBe(source.text);
    expect(words.find((word) => word.text.includes('12'))).toMatchObject({ begin_time: 700, end_time: 1300 });
    expect(captionsFromWords(source, 2.2, 'ja').map((cue) => cue.text).join('')).toBe(source.text);
  });
  it('keeps a reduced Japanese real-word timestamp example', () => {
    const source = meta('12番の鏡の少女主張について。', [
      { text: '十', begin_time: 3237, end_time: 3561 }, { text: '二', begin_time: 3561, end_time: 3884 },
      { text: '番', begin_time: 3884, end_time: 4208 }, { text: 'の', begin_time: 4208, end_time: 4532 },
      { text: '鏡', begin_time: 4532, end_time: 4855 }, { text: 'の', begin_time: 4855, end_time: 5179 },
      { text: '少', begin_time: 5179, end_time: 5503 }, { text: '女', begin_time: 5503, end_time: 5826 },
      { text: '主', begin_time: 5826, end_time: 6150 }, { text: '張', begin_time: 6150, end_time: 6474 },
      { text: 'について', begin_time: 6474, end_time: 6798 },
    ]);
    const words = sourceCaptionWords(source, 'ja');
    expect(words[0]).toMatchObject({ text: '12', begin_time: 3237, end_time: 3884 });
    expect(words.map((word) => word.text).join('')).toBe(source.text);
  });
  it('rejects missing, extra and replaced words even when character counts match', () => {
    for (const label of ['Player five', 'Player thre', 'Player three extra']) {
      expect(() => sourceCaptionWords(meta('Player 3', [{ text: label, begin_time: 0, end_time: 1000 }]), 'en')).toThrow(/realignment is required/);
    }
    expect(() => sourceCaptionWords(meta('12番', [{ text: '十三番', begin_time: 0, end_time: 1000 }]), 'ja')).toThrow(/realignment is required/);
    expect(() => sourceCaptionWords(meta('2+3', [{ text: 'two three', begin_time: 0, end_time: 1000 }]), 'en')).toThrow(/realignment is required/);
    expect(sourceCaptionWords(meta('2+3', [{ text: 'two plus three', begin_time: 0, end_time: 1000 }]), 'en')[0].text).toBe('2+3');
  });
  it('rejects invalid or suspiciously separated number timestamps instead of estimating', () => {
    const bad = meta('12番', [{ text: '十', begin_time: 160, end_time: 240 }, { text: '二', begin_time: 6720, end_time: 6800 }, { text: '番', begin_time: 6800, end_time: 6960 }]);
    expect(() => sourceCaptionWords(bad, 'ja')).toThrow(/gap inside a number/);
    const reversed = meta('Player 3', [{ text: 'Player', begin_time: 500, end_time: 700 }, { text: ' three', begin_time: 200, end_time: 400 }]);
    expect(() => sourceCaptionWords(reversed, 'en')).toThrow(/Out-of-order/);
  });
  it('labels the actual audio language without altering the audio', () => {
    expect(['zh-CN', 'en', 'ja', 'fr', 'bad_locale'].map(videoAudioLanguage)).toEqual(['zho', 'eng', 'jpn', 'und', 'und']);
  });
});
