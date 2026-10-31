import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { projectDir, FPS, SAMPLE_RATE, ffprobe, type Script, type TimedClip } from './project';
import { replay } from './replay';
import { readPcm } from './audio';

const source = JSON.parse(await readFile(`${projectDir}/source.json`, 'utf8')) as Script;
const script = JSON.parse(await readFile(`${projectDir}/script.json`, 'utf8')) as Script;
const timeline = JSON.parse(await readFile(`${projectDir}/timeline.json`, 'utf8')) as { frames: number; duration: number; clips: TimedClip[] };
assert.deepEqual(script.events, source.events, 'Editorial changed the game facts');
const sourcePlayers = source.chapters.flatMap((c) => c.entries).filter((e) => e.seat !== undefined);
for (const e of sourcePlayers) {
  const chunks = timeline.clips.filter((c) => c.sourceSeq === e.sourceSeq);
  assert(chunks.length > 0);
  assert.equal(chunks.map((c) => c.text).join('').replace(/\s/g, ''), e.text.replace(/\s/g, ''), `Changed player speech at ${e.sourceSeq}`);
  assert(chunks.every((c) => c.voiceKey === e.voiceKey && c.seat === e.seat));
}
const final = replay(source, Number.MAX_SAFE_INTEGER), review = source.events.findLast((e) => e.type === 'review');
assert(review, 'Missing recorded end review');
assert.deepEqual([...final.alive].sort((a, b) => a - b), review.data.roles.filter((r: any) => r.alive).map((r: any) => r.seat).sort((a: number, b: number) => a - b));
assert.equal(final.result.winner, source.result.winner);
let cursor = 0, captions = 0;
for (const c of timeline.clips) {
  assert.equal(c.startFrame, cursor); cursor += c.frames;
  assert(c.captions.length && c.audioMeta.text === c.spokenText);
  for (const cue of c.captions) assert(cue.start >= 0 && cue.end > cue.start && cue.end <= c.audioDuration + .001);
  const pcm = await readPcm(`${projectDir}/audio-normalized/${c.id}.wav`);
  assert.equal(pcm.sampleRate, SAMPLE_RATE); assert.equal(pcm.samples.length, c.frames * SAMPLE_RATE / FPS);
  assert.equal(JSON.parse(await readFile(`${projectDir}/segments/${c.id}.mp4.json`, 'utf8')).frames, c.frames);
  const log = await readFile(`${projectDir}/segments/${c.id}.mp4.log`, 'utf8');
  assert(!/corrupt|invalid data|error while/i.test(log), `Encoding problem in ${c.id}`);
  captions += c.captions.length;
}
assert.equal(cursor, timeline.frames);
const video = `${projectDir}/output/latest-match.mp4`;
const media = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', video], { encoding: 'utf8', windowsHide: true }));
const picture = media.streams.find((s: any) => s.codec_type === 'video'), audio = media.streams.find((s: any) => s.codec_type === 'audio');
assert.equal(picture.width, 1920); assert.equal(picture.height, 1080); assert.equal(picture.r_frame_rate, '30/1');
assert.equal(Number(picture.nb_frames), timeline.frames); assert.equal(audio.codec_name, 'aac');
assert(Math.abs(Number(picture.duration) - timeline.duration) < 1 / FPS);
assert(Math.abs(Number(audio.duration) - timeline.duration) < .05);
assert.equal(media.chapters.length, source.chapters.length);
const report = { roomId: source.roomId, video, bytes: (await stat(video)).size, durationSeconds: timeline.duration, frames: timeline.frames,
  resolution: '1920×1080', fps: FPS, chapters: media.chapters.length, clips: timeline.clips.length, captions,
  originalPlayerEntriesPreserved: sourcePlayers.length, privateWolfChatIncluded: true, perspective: 'god', factsUnchanged: true,
  finalAliveSeats: [...final.alive], winner: final.result.winnerName, audioVideoDifferenceSeconds: Math.abs(Number(picture.duration) - Number(audio.duration)),
  voices: [...new Set(timeline.clips.map((c) => c.audioMeta.voice))].length };
await writeFile(`${projectDir}/output/verification.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
