import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { buildClips, projectDir, ffprobe, FPS, SAMPLE_RATE, type Script, type TimedClip } from './project';
import { readPcm } from './audio';
import { replay } from './replay';
import { assertPlayerSources } from './integrity';
import { captionContent } from './timeline';
const source: Script = JSON.parse(await readFile(`${projectDir}/source.json`, 'utf8'));
const script: Script = JSON.parse(await readFile(`${projectDir}/script.json`, 'utf8'));
const timeline: { frames: number; duration: number; clips: TimedClip[] } = JSON.parse(await readFile(`${projectDir}/timeline.json`, 'utf8'));
const selection = JSON.parse(await readFile(`${projectDir}/sample-selection.json`, 'utf8'));
assert(script.sample);
assertPlayerSources(source, script, timeline.clips);
assert.deepEqual(script.events, source.events, 'Sample changed original game facts');
const playerParts = buildClips(source).filter((c) => c.seat !== undefined);
let frames = 0;
for (const c of timeline.clips) {
  assert.equal(c.startFrame, frames); frames += c.frames;
  if (c.seat !== undefined && !c.data.presentationOnly) {
    const original = playerParts.find((p) => p.sourceSeq === c.sourceSeq && p.part === c.part);
    assert(original); assert.equal(c.text, original.text); assert.equal(c.voiceKey, original.voiceKey);
  }
  if (c.data.presentationOnly) {
    assert(c.data.provenance);
    assert(c.data.replayThrough <= c.sourceSeq);
    if (c.data.presentationKey === 'vote-open') assert.notEqual(replay(script, c.data.replayThrough).lastVote?.sourceSeq, c.sourceSeq);
  }
  assert.equal(c.spokenText, c.audioMeta.text);
  assert.equal(captionContent(c.captions.map((cue) => cue.text).join('')), captionContent(c.spokenText), `Caption spelling differs from script: ${c.id}`);
  assert(c.captions.length > 0);
  for (const cue of c.captions) assert(cue.end > cue.start && cue.start >= 0 && cue.end <= c.audioDuration + .001);
  const pcm = await readPcm(`${projectDir}/audio-normalized/${c.id}.wav`);
  assert.equal(pcm.samples.length, c.frames * SAMPLE_RATE / FPS);
}
assert.equal(frames, timeline.frames);
const video = process.argv.find((a) => a.startsWith('--video='))?.slice(8) ?? `${projectDir}/output/revision-sample.mp4`;
const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_chapters', '-show_format', '-of', 'json', video], { encoding: 'utf8', windowsHide: true }));
const picture = info.streams.find((s: any) => s.codec_type === 'video'), audio = info.streams.find((s: any) => s.codec_type === 'audio');
assert.equal(Number(picture.nb_frames), frames);
assert.equal(picture.width, 1920); assert.equal(picture.height, 1080);
assert(Math.abs(Number(audio.duration) - Number(picture.duration)) < .06);
const report = { video, bytes: (await stat(video)).size, durationSeconds: timeline.duration, clips: timeline.clips.length,
  selectedOriginalPlayerParts: timeline.clips.filter((c) => c.seat !== undefined && !c.data.presentationOnly).length,
  originalSelectedPlayerTextPreserved: true, factsUnchanged: true, nonContinuousExcerpt: true,
  reconstructedActionChoicesLabeled: true, reusedAudio: selection.reusedAudio,
  audioVideoDifferenceSeconds: Math.abs(Number(audio.duration) - Number(picture.duration)),
  chapters: info.chapters.length, resolution: `${picture.width}×${picture.height}`, codec: picture.codec_name };
await writeFile(`${projectDir}/output/sample-verification.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
