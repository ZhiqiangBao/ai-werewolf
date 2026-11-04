import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairAudio } from '../../../../scripts/video/repair-audio';
import { wavHeader, readPcm } from '../../../../scripts/video/audio';
import { inspectAudio } from '../../../../scripts/video/audio-inspection';
import { captionsFromWords } from '../../../../scripts/video/timeline';
import type { Script, Clip, VoiceCatalog } from '../../../../scripts/video/project';
import type { AudioMeta, SpeechSynthesizer } from '../../../../scripts/video/tts-types';

test('English numeric timestamp labels pass repair without changing the original words or voice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-repair-locale-'));
  try {
    const text = 'I have 1.5 votes.';
    const entry = { sourceSeq: 1, type: 'game.start', speaker: 'Judge', voiceKey: 'judge', text, visibility: 'public', data: {} };
    const source: Script = { roomId: 'synthetic-repair', locale: 'en', perspective: 'god', status: 'ended', presetName: 'Synthetic', cast: [], events: [], result: {},
      chapters: [{ day: 0, phase: 'setup', title: 'Setup', entries: [entry] }] };
    const audioFile = join(directory, 'audio', '001-1.wav');
    const clip: Clip = { ...entry, id: '001-1', day: 0, phase: 'setup', chapter: 'Setup', part: 1, parts: 1, spokenText: text, audioFile };
    const voices: VoiceCatalog = { model: 'synthetic-test', profiles: { judge: { voice: 'synthetic-judge', label: 'Judge', rate: 1, instruction: '' } } };
    const words = [
      { text: 'I', begin_time: 10, end_time: 80 },
      { text: 'have', begin_time: 110, end_time: 260 },
      { text: 'one', begin_time: 280, end_time: 430 },
      { text: 'point', begin_time: 470, end_time: 600 },
      { text: 'five', begin_time: 650, end_time: 820 },
      { text: 'votes.', begin_time: 870, end_time: 1100 },
    ];
    // Deterministic synthetic PCM and explicitly synthetic timings, never real speech.
    const wave = (damaged: boolean) => {
      const frames = 28800, pcm = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) pcm.writeInt16LE(damaged && i >= 10000 && i < 12500 ? 32767 : Math.round(5000 * Math.sin(2 * Math.PI * 397 * i / 24000)), i * 2);
      return Buffer.concat([wavHeader(frames, 24000), pcm]);
    };
    const meta = (bytes: Buffer, cacheKey: string): AudioMeta => ({ cacheKey, provider: 'synthetic-test', model: voices.model, voice: voices.profiles.judge.voice, text, bytes: bytes.length,
      sentences: [{ index: 0, text, words }] });
    await mkdir(join(directory, 'audio'));
    const original = wave(true);
    for (const [name, value] of [['source.json', source], ['script.json', source], ['clips.json', [clip]], ['voices.json', voices]] as const) await writeFile(join(directory, name), JSON.stringify(value));
    await writeFile(audioFile, original);
    await writeFile(`${audioFile}.json`, JSON.stringify(meta(original, 'original')));
    const clean = wave(false), cleanMeta = meta(clean, 'replacement');
    assert.throws(() => captionsFromWords(cleanMeta, 1.2), /Timestamp labels/);
    assert.equal(captionsFromWords(cleanMeta, 1.2, 'en').map((cue) => cue.text).join(''), text);
    const synthesize: SpeechSynthesizer = async (requested, profile, model, output) => {
      assert.equal(requested, text); assert.equal(profile.voice, voices.profiles.judge.voice); assert.equal(profile.locale, 'en'); assert.equal(model, voices.model);
      await writeFile(output, clean); await writeFile(`${output}.json`, JSON.stringify(cleanMeta)); return cleanMeta;
    };
    const report = await repairAudio(directory, { ids: [clip.id], maxAttempts: 1, synthesize });
    assert.equal(report.complete, true);
    assert.equal(report.entries[0].status, 'replaced');
    assert.deepEqual(await readFile(report.entries[0].backup!), original);
    const pcm = await readPcm(audioFile);
    assert.equal(inspectAudio(pcm.samples, pcm.sampleRate).issues.length, 0);
    assert.equal(JSON.parse(await readFile(`${audioFile}.json`, 'utf8')).text, text);
    assert.equal(JSON.parse(await readFile(join(directory, 'voices.json'), 'utf8')).clipSeeds[clip.id], 31416);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
