import { describe, expect, it } from 'vitest';
import { captionsFromWords, sourceCaptionWords } from '../../../scripts/video/timeline';
import { wrapEnglishCaption } from '../../../scripts/video/english-captions';
import type { AudioMeta } from '../../../scripts/video/qwen';

function meta(text: string, labels: string[]): AudioMeta {
  return { text, cacheKey: '', model: '', voice: '', bytes: 0, sentences: [{ index: 0, text, words: labels.map((part, i) => ({ text: part, begin_time: i * 300, end_time: i * 300 + 250 })) }] };
}
describe('English semantic captions', () => {
  it('retains original spelling and punctuation while using complete words and source times', () => {
    const text = 'Player 5 believes the werewolf is hiding, but the other players should listen carefully.';
    const labels = ['play','er',' five',' believes',' the',' were','wolf',' is',' hiding',', but',' the',' other',' players',' should',' listen',' carefully'];
    const source = meta(text, labels), words = sourceCaptionWords(source, 'en');
    const captions = captionsFromWords(source, 10, 'en-US');
    expect(captions.map(c => c.text).join('')).toBe(text);
    expect(captions.length).toBeGreaterThan(0);
    for (const c of captions) {
      expect(words.some(w => Math.abs(c.start - Math.max(0, w.begin_time / 1000 - .06)) < 1e-8)).toBe(true);
      expect(words.some(w => Math.abs(c.end - (w.end_time / 1000 + .12)) < 1e-8) || captions.some(other => other.start === c.end)).toBe(true);
      expect(c.text.trim()).not.toMatch(/\b(?:Player|the|should)$/i);
      expect(c.text.trim()).not.toMatch(/^(?:5|wolf)\b/i);
    }
  });
  it('keeps short emphasis and avoids an isolated final word', () => {
    const text = 'No! I think the player is telling the truth and we should listen to her.';
    const source = meta(text, ['No',' I',' think',' the',' player',' is',' telling',' the',' truth',' and',' we',' should',' listen',' to',' her']);
    const cues = captionsFromWords(source, 10, 'en');
    expect(cues.map(c => c.text).join('')).toBe(text);
    expect(cues.at(-1)!.text.trim().split(/\s+/).length).toBeGreaterThan(1);
  });
  it('keeps negation attached to its object after a short sentence', () => {
    const text = 'My suspect is Player 4. Not for the claim, but for the pattern. I cannot ignore the evidence.';
    const labels = ['My', ' suspect', ' is', ' Player', ' four', ' Not', ' for', ' the', ' claim', ' but', ' for', ' the', ' pattern', ' I', ' cannot', ' ignore', ' the', ' evidence'];
    const cues = captionsFromWords(meta(text, labels), 10, 'en');
    expect(cues.map(c => c.text).join('')).toBe(text);
    for (const cue of cues) expect(cue.text.trim()).not.toMatch(/\b(?:not|the|is|for|cannot)$/i);
    expect(cues.some(c => /Not for the claim/.test(c.text))).toBe(true);
  });
  it('separates sentences and protects full role phrases and dependent clauses', () => {
    const text = 'I suspect Player 4. Not for the claim. He asked whether a real Seer or Witch would remain silent. That is fine, because he said nothing.';
    const labels = ['I',' suspect',' Player',' four',' Not',' for',' the',' claim',' He',' asked',' whether',' a',' real',' Seer',' or',' Witch',' would',' remain',' silent',' That',' is',' fine',' because',' he',' said',' nothing'];
    const cues = captionsFromWords(meta(text, labels), 12, 'en');
    expect(cues.map(c => c.text).join('')).toBe(text);
    expect(cues.map(c => c.text.trim())).toEqual(['I suspect Player 4.', 'Not for the claim.', 'He asked whether a real Seer or Witch would remain silent.', 'That is fine, because he said nothing.']);
  });
  it('wraps at a word boundary without changing capitalization or content', () => {
    const text = 'Player 5 believes the other player is telling the truth.';
    const wrapped = wrapEnglishCaption(text);
    expect(wrapped).toContain('\n');
    expect(wrapped.replace('\n', ' ')).toBe(text);
    expect(wrapped).not.toMatch(/\bPlayer\n5\b/);
  });
  it('retains strict mismatch and ordering checks', () => {
    expect(() => captionsFromWords(meta('The player speaks.', ['the', ' wolf', ' speaks']), 3, 'en')).toThrow();
    const invalid = meta('The player speaks.', ['the', ' player', ' speaks']);
    invalid.sentences[0].words[1].begin_time = -1;
    expect(() => captionsFromWords(invalid, 3, 'en')).toThrow();
  });
});
