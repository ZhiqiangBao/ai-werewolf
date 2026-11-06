import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editScript } from '../../../scripts/video/editorial';
import { assertPlayerSources } from '../../../scripts/video/integrity';
import { buildClips, spokenText, validateSpeechParts, type Script } from '../../../scripts/video/project';

const source = { roomId: 'test', perspective: 'god', locale: 'en', presetName: 'test', status: 'ended', result: null, cast: [], events: [], chapters: [{ day: 1, phase: 'day', title: 'Day', entries: [
  { sourceSeq: 40, type: 'speech', speaker: 'Player', voiceKey: 'seat-1', seat: 1, text: 'If a player speaks, words.', visibility: 'public', data: {} },
  { sourceSeq: 41, type: 'phase', speaker: 'Judge', voiceKey: 'judge', text: 'Day', visibility: 'public', data: {} },
] }] } as Script;

describe('mechanical player speech parts', () => {
  it('preserves source facts through editorial, hosting and integrity checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'speech-parts-'));
    const previous = process.env.VIDEO_NARRATION_FILE;
    try {
      const file = join(dir, 'narration.json');
      await writeFile(file, JSON.stringify({ roomId: 'test', edits: {}, speechParts: { 40: ['If a player ', 'speaks, words.'] } }));
      process.env.VIDEO_NARRATION_FILE = file;
      const edited = await editScript(source), clips = buildClips(edited);
      expect(edited.chapters[0].entries.find((e) => e.sourceSeq === 40)?.text).toBe(source.chapters[0].entries[0].text);
      expect(clips.filter((c) => c.seat === 1).map((c) => c.text)).toEqual(['If a player ', 'speaks, words.']);
      expect(() => assertPlayerSources(source, edited, clips)).not.toThrow();
      expect(() => assertPlayerSources(source, { ...edited, speechParts: { 40: ['invented'] } }, clips)).toThrow();
    } finally { if (previous === undefined) delete process.env.VIDEO_NARRATION_FILE; else process.env.VIDEO_NARRATION_FILE = previous; await rm(dir, { recursive: true, force: true }); }
  });
  it('rejects invalid anchors, missing, added and reordered text, empty parts and oversize parts', () => {
    for (const parts of [{ 42: ['If a player speaks, words.'] }, { 41: ['Day'] }, { 40: [] }, { 40: [' '] }, { 40: ['If a player speaks'] }, { 40: ['If a player speaks, words. added'] }, { 40: ['words.', 'If a player speaks, '] }, { 40: ['a'.repeat(601)] }, { 40: 'If a player speaks, words.' }, []]) {
      expect(() => validateSpeechParts(source, parts)).toThrow();
    }
    expect(() => validateSpeechParts({ ...source, perspective: 'player' }, { 40: ['If a player speaks, words.'] })).toThrow();
  });
  it('rejects speech parts in player-view narration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'speech-parts-player-'));
    const previous = process.env.VIDEO_NARRATION_FILE;
    try {
      const file = join(dir, 'narration.json');
      await writeFile(file, JSON.stringify({ roomId: 'test', playerSeat: 1, edits: {}, speechParts: {} }));
      process.env.VIDEO_NARRATION_FILE = file;
      await expect(editScript({ ...source, perspective: 'player', playerSeat: 1 })).rejects.toThrow();
    } finally { if (previous === undefined) delete process.env.VIDEO_NARRATION_FILE; else process.env.VIDEO_NARRATION_FILE = previous; await rm(dir, { recursive: true, force: true }); }
  });
  it('only expands the specified role alternative', () => {
    expect(spokenText('claims Seer/ Hunter to split', 'en')).toBe('claims Seer or Hunter to split');
    expect(spokenText('a/b 1/2 https://example.com', 'en')).toBe('a/b 1/2 https://example.com');
  });
});
