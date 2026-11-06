import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClips, spokenText, validateEnglishPossessiveClips, type Script } from '../../../scripts/video/project';
import { editScript } from '../../../scripts/video/editorial';
import { assertPlayerSources } from '../../../scripts/video/integrity';

const source: Script = { roomId: 'test', perspective: 'god', locale: 'en', presetName: 'test', status: 'ended', result: null, cast: [], events: [], chapters: [{ day: 1, phase: 'day', title: 'Day', entries: [
  { sourceSeq: 53, type: 'speech', speaker: 'Player', voiceKey: 'seat-1', seat: 1, text: "5's summary and 21's vote", visibility: 'public', data: {} },
  { sourceSeq: 97, type: 'speech', speaker: 'Player', voiceKey: 'seat-2', seat: 2, text: "wolves’ target and players' votes, it's true", visibility: 'public', data: {} },
  { sourceSeq: 98, type: 'speech', speaker: 'Player', voiceKey: 'seat-2', seat: 2, text: "it's ordinary", visibility: 'public', data: {} },
  { sourceSeq: 99, type: 'phase', speaker: 'Judge', voiceKey: 'judge', text: "5's", visibility: 'public', data: {} },
] }] };
describe('opt-in English possessives', () => {
  it('normalizes only supported numeric and plural forms', () => {
    expect(spokenText("5's 21's 0's 99’s wolves’ players' it's", 'en', true)).toBe("five's twenty-one's zero's ninety-nine's wolves players it's");
    expect(spokenText("5's wolves'", 'en')).toBe("5's wolves'");
    expect(spokenText("100's 05's A5's", 'en', true)).toBe("100's 05's A5's");
  });
  it('changes only selected clips and keeps original player text and facts', () => {
    const original = buildClips(source), edited = { ...source, englishPossessiveClips: ['053-1', '097-1'] };
    const clips = buildClips(edited);
    expect(clips.map(c => c.id)).toEqual(original.map(c => c.id));
    expect(clips.map(c => c.text)).toEqual(original.map(c => c.text));
    expect(clips.filter((c, i) => c.spokenText !== original[i].spokenText).map(c => c.id)).toEqual(['053-1', '097-1']);
    expect(clips[0].spokenText).toBe("five's summary and twenty-one's vote");
    expect(() => assertPlayerSources(source, edited, clips)).not.toThrow();
    expect(() => assertPlayerSources(source, edited, clips.map(c => c.id === '053-1' ? { ...c, spokenText: 'forged' } : c))).toThrow();
  });
  it('rejects unknown, duplicated, judge, unexpandable, non-English and player selections', () => {
    for (const ids of [['unknown'], ['053-1', '053-1'], ['099-1'], ['098-1'], ['053-1', 1], '053-1']) expect(() => validateEnglishPossessiveClips(source, ids)).toThrow();
    expect(() => validateEnglishPossessiveClips({ ...source, perspective: 'player' }, ['053-1'])).toThrow();
    expect(() => validateEnglishPossessiveClips({ ...source, locale: 'ja' }, ['053-1'])).toThrow();
  });
  it('validates narration and preserves choices through hosting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'possessive-clips-')); const old = process.env.VIDEO_NARRATION_FILE;
    try {
      const file = join(dir, 'narration.json'); process.env.VIDEO_NARRATION_FILE = file;
      await writeFile(file, JSON.stringify({ roomId: 'test', edits: {}, englishPossessiveClips: ['053-1'] }));
      const edited = await editScript(source); expect(edited.englishPossessiveClips).toEqual(['053-1']);
      expect(edited.chapters[0].entries.find(e => e.sourceSeq === 53)?.text).toBe(source.chapters[0].entries[0].text);
      await writeFile(file, JSON.stringify({ roomId: 'test', edits: {}, englishPossessiveClips: ['unknown'] }));
      await expect(editScript(source)).rejects.toThrow();
      await writeFile(file, JSON.stringify({ roomId: 'test', playerSeat: 1, edits: {}, englishPossessiveClips: [] }));
      await expect(editScript({ ...source, perspective: 'player', playerSeat: 1 })).rejects.toThrow();
    } finally { if (old === undefined) delete process.env.VIDEO_NARRATION_FILE; else process.env.VIDEO_NARRATION_FILE = old; await rm(dir, { recursive: true, force: true }); }
  });
});
