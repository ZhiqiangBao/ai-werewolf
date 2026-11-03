import assert from 'node:assert/strict';
import type { Clip, Script, VoiceCatalog } from './project';
import { buildClips, splitSpeech, spokenText } from './project';
import { replay } from './replay';
import { hostingChoice } from './hosting';
import { open, readFile } from 'node:fs/promises';
import { FPS, SAMPLE_RATE, loadScript, projectDir } from './project';
import { wavHeader } from './audio';

/** Cross-check persisted player artifacts against the selected seat export before consuming caches. */
export async function assertAuthorizedProject(clips: Clip[]) {
  const source = JSON.parse(await readFile(`${projectDir}/source.json`, 'utf8')) as Script;
  const script = JSON.parse(await readFile(`${projectDir}/script.json`, 'utf8')) as Script;
  if (process.env.VIDEO_PLAYER_SEAT || source.perspective === 'player' || script.perspective === 'player') {
    assert(source.perspective === 'player' && script.perspective === 'player', 'Mixed player and god view artifacts');
    assert.deepEqual(source, await loadScript(), 'Player source differs from selected authorized export');
    assertPlayerSources(source, script, clips);
  }
  return { source, script };
}

/** Reject stale normalized audio and altered timing metadata before consuming player clips. */
export async function assertPlayerAudio(clips: import('./project').TimedClip[]) {
  if (!process.env.VIDEO_PLAYER_SEAT) return undefined;
  const { createHash } = await import('node:crypto');
  const { assDocument, srtDocument } = await import('./timeline');
  const { assertPlayerRawAudio } = await import('./player-audio-provenance');
  const source = await loadScript();
  await assertPlayerRawAudio(source, JSON.parse(await readFile(`${projectDir}/voices.json`, 'utf8')) as VoiceCatalog, clips);
  const master = await open(`${projectDir}/master.wav`, 'r');
  const masterHash = createHash('sha256');
  let masterOffset = 0;
  async function readMaster(length: number) {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await master.read(buffer, read, length - read, masterOffset + read);
      assert(result.bytesRead > 0, 'Player master audio is truncated');
      read += result.bytesRead;
    }
    masterOffset += length;
    masterHash.update(buffer);
    return buffer;
  }
  try {
    let frameCursor = 0;
    for (const clip of clips) {
      assert(Number.isSafeInteger(clip.frames) && clip.frames > 0 && clip.startFrame === frameCursor, 'Invalid player audio timing');
      frameCursor += clip.frames;
    }
    const totalSamples = frameCursor * SAMPLE_RATE / FPS;
    assert(Number.isSafeInteger(totalSamples), 'Invalid player master sample count');
    const header = wavHeader(totalSamples, SAMPLE_RATE);
    assert.deepEqual(await readMaster(header.length), header, 'Player master WAV header differs from timeline');
    assert.equal((await master.stat()).size, header.length + totalSamples * 2, 'Player master WAV size differs from timeline');
    for (const clip of clips) {
      assert.equal(clip.audioMeta.text, clip.spokenText, `Stale player audio metadata: ${clip.id}`);
      assert.deepEqual(JSON.parse(await readFile(`${clip.audioFile}.json`, 'utf8')), clip.audioMeta, `Changed player audio metadata: ${clip.id}`);
      const bytes = await readFile(`${projectDir}/audio-normalized/${clip.id}.wav`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), clip.normalizedAudioSha256, `Stale player audio: ${clip.id}`);
      const expectedSamples = clip.frames * SAMPLE_RATE / FPS;
      assert(Number.isSafeInteger(expectedSamples), `Invalid sample count: ${clip.id}`);
      const expectedHeader = wavHeader(expectedSamples, SAMPLE_RATE);
      assert.equal(bytes.length, expectedHeader.length + expectedSamples * 2, `Invalid normalized WAV size: ${clip.id}`);
      assert.deepEqual(bytes.subarray(0, expectedHeader.length), expectedHeader, `Invalid normalized WAV header: ${clip.id}`);
      assert.deepEqual(await readMaster(expectedSamples * 2), bytes.subarray(expectedHeader.length), `Player master audio differs from authorized clip: ${clip.id}`);
      assert.equal(clip.captions.map((c) => c.text).join('').replace(/[\s\p{P}\p{S}]/gu, ''), clip.spokenText.replace(/[\s\p{P}\p{S}]/gu, ''), `Changed player subtitles: ${clip.id}`);
      assert.equal(await readFile(`${projectDir}/subtitles/${clip.id}.ass`, 'utf8'), assDocument(clip.captions, clip.phase), `Changed player subtitle file: ${clip.id}`);
    }
  } finally { await master.close(); }
  const cues = clips.flatMap((c) => c.captions.map((cue) => ({ ...cue, phase: c.phase, start: cue.start + c.startFrame / 30, end: cue.end + c.startFrame / 30 })));
  assert.equal(await readFile(`${projectDir}/subtitles/captions.ass`, 'utf8'), assDocument(cues), 'Changed combined player subtitle file');
  assert.equal(await readFile(`${projectDir}/subtitles/captions.srt`, 'utf8'), srtDocument(cues), 'Changed player SRT file');
  return masterHash.digest('hex');
}

/** Check the final bytes against the render result and the freshly validated source and master. */
export async function assertPlayerVideo(source: Script, video: string, masterSha256: string | undefined) {
  if (source.perspective !== 'player') return;
  assert(masterSha256, 'Player master audio was not validated');
  const { createHash } = await import('node:crypto');
  const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const report = JSON.parse(await readFile(`${projectDir}/output/render-report.json`, 'utf8'));
  assert.equal(report.viewHash, digest(JSON.stringify(source)), 'Video belongs to another view');
  assert.equal(report.masterSha256, masterSha256, 'Video is not bound to the validated master audio');
  assert.equal(report.videoSha256, digest(await readFile(video)), 'Final video differs from render report');
}

/** Refuse invented player speech before any TTS request, including prepared/sample manifests. */
export function assertPlayerSources(source: Script, script: Script, clips: Clip[]) {
  assert.deepEqual(script.events, source.events, 'Video editorial changed original game facts');
  if (source.perspective === 'player') {
    const { sample, ...withoutSample } = script;
    assert.deepEqual(withoutSample, source, 'Player view cannot use edited or omniscient material');
    const expected = buildClips(source);
    const fields = (c: Clip) => ({ id: c.id, sourceSeq: c.sourceSeq, type: c.type, speaker: c.speaker, text: c.text, seat: c.seat, voiceKey: c.voiceKey, visibility: c.visibility, day: c.day, phase: c.phase, chapter: c.chapter, part: c.part, parts: c.parts, spokenText: c.spokenText, audioFile: c.audioFile, data: Object.fromEntries(Object.entries(c.data).filter(([key]) => key !== 'sampleSection')) });
    let last = -1;
    for (const clip of clips) {
      const index = expected.findIndex((item) => item.id === clip.id);
      assert(index > last, 'Player clips must be unique and in authorized order');
      assert.deepEqual(fields(clip), fields(expected[index]), 'Player view clip differs from its authorized entry');
      last = index;
    }
    if (!sample) assert.equal(clips.length, expected.length, 'Complete player view must include every clip');
  }
  const entries = source.chapters.flatMap((c) => c.entries);
  for (const clip of clips) {
    assert.equal(clip.spokenText, spokenText(clip.text, source.locale ?? 'zh-CN'), 'Spoken text changed beyond pronunciation normalization');
    if (clip.seat === undefined) {
      assert(!clip.voiceKey.startsWith('seat-'), 'A character voice needs a recorded speech or action source');
      continue;
    }
    assert.equal(clip.voiceKey, `seat-${clip.seat}`);
    if (!clip.data.presentationOnly) {
      const original = entries.find((e) => e.sourceSeq === clip.sourceSeq && e.seat === clip.seat);
      assert(original, `Missing original player speech at ${clip.sourceSeq}`);
      assert.equal(clip.text, splitSpeech(original.text, 230, source.locale ?? 'zh-CN')[clip.part - 1], `Player words changed at ${clip.sourceSeq}`);
      continue;
    }
    assert.equal(clip.type, 'hosting.choice', 'Generated character dialogue is forbidden');
    assert(!entries.find((e) => e.sourceSeq === clip.sourceSeq)?.data.systemFallback, 'System fallback cannot become a model choice');
    const fact = source.events.find((f) => f.sourceSeq === clip.sourceSeq);
    assert(fact, 'Recorded action is missing');
    const d = fact.data;
    const actor = Array.isArray(fact.audience) && fact.audience.length === 1 ? fact.audience[0] : undefined;
    const expected = hostingChoice(source.locale ?? 'zh-CN', fact.type, d);
    if (fact.type === 'speech.order') {
      const sheriff = replay(source, fact.sourceSeq - 1).sheriff;
      assert.equal(clip.seat, sheriff);
      assert.equal(clip.text, expected);
    } else {
      assert.equal(clip.seat, actor, 'Action narration assigned to the wrong actor');
      assert(expected, 'This event cannot authorize generated character dialogue');
      assert.equal(clip.text, expected, 'Action narration added unrecorded speech');
    }
  }
}
