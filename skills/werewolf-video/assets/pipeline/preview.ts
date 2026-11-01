import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { projectDir, ffmpeg, SAMPLE_RATE, FPS, type Script, type TimedClip } from './project';
import { readPcm, wavHeader } from './audio';
import { encodingSettings } from './encoding';
const timeline = JSON.parse(await readFile(`${projectDir}/timeline.json`, 'utf8')) as { clips: TimedClip[] };
const script = JSON.parse(await readFile(`${projectDir}/script.json`, 'utf8')) as Script;
const first = (type: string) => timeline.clips.find((c) => c.type === type);
const choices = [first('game.start'), first('wolf.chat'), first('seer.result'), first('speech'), first('vote.result'), first('badge.transfer'),
  timeline.clips.findLast((c) => c.type === 'dawn'), first('game.end')];
const clips = [...new Map(choices.filter((c): c is TimedClip => !!c).map((c) => [c.id, c])).values()].sort((a, b) => a.startFrame - b.startFrame);
await mkdir(`${projectDir}/output/review`, { recursive: true });
await writeFile(`${projectDir}/preview.ffconcat`, 'ffconcat version 1.0\n' + clips.map((c) => `file 'segments/${c.id}.mp4'`).join('\n') + '\n');
const frames = clips.reduce((n, c) => n + c.frames, 0), wav = await open(`${projectDir}/preview.wav`, 'w');
await wav.write(wavHeader(frames * SAMPLE_RATE / FPS, SAMPLE_RATE));
for (const clip of clips) { const { samples } = await readPcm(`${projectDir}/audio-normalized/${clip.id}.wav`); await wav.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)); }
await wav.close();
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'preview.ffconcat', '-i', 'preview.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', `${encodingSettings().audioKbps}k`, '-metadata', 'title=流程样片·含终局节选', '-movflags', '+faststart', 'output/workflow-preview.mp4'], { cwd: projectDir, windowsHide: true, stdio: 'inherit' });
const longestName = [...timeline.clips].filter((c) => c.type === 'speech').sort((a, b) =>
  (script.cast.find((p) => p.seat === b.seat)?.name.length ?? 0) - (script.cast.find((p) => p.seat === a.seat)?.name.length ?? 0))[0];
const frameChoices = [
  ...[first('wolf.chat'), first('speech'), first('vote.result'), first('game.end')].filter((c): c is TimedClip => !!c).map((clip) => ({ name: clip.type.replace('.', '-'), clip })),
  { name: 'speaker-commentator', clip: timeline.clips.find((c) => c.voiceKey === 'commentator') },
  { name: 'speaker-judge-night', clip: timeline.clips.find((c) => c.voiceKey === 'judge' && c.phase === 'night') },
  { name: 'speaker-judge-day', clip: timeline.clips.find((c) => c.voiceKey === 'judge' && c.phase === 'day') },
  { name: 'speaker-player-long-name', clip: longestName },
  { name: 'speaker-action', clip: first('hosting.choice') },
].filter((item): item is { name: string; clip: TimedClip } => !!item.clip);
for (const { name, clip } of frameChoices) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(clip.startFrame / FPS + Math.min(1, clip.audioDuration / 2)), '-i', 'output/latest-match.mp4', '-frames:v', '1', `output/review/${name}.jpg`], { cwd: projectDir, windowsHide: true, stdio: 'inherit' });
}
await writeFile(`${projectDir}/output/preview-selection.json`, JSON.stringify({ description: '非连续节选，用于检查夜间、玩家、上帝、票型与终局（如选段含终局）', duration: frames / FPS, clips: clips.map((c) => ({ id: c.id, sourceSeq: c.sourceSeq, type: c.type })),
  reviewFrames: frameChoices.map(({ name, clip }) => ({ file: `review/${name}.jpg`, clip: clip.id })) }, null, 2));
console.log(JSON.stringify({ preview: `${projectDir}/output/workflow-preview.mp4`, durationSeconds: frames / FPS, sampledFrames: frameChoices.length }));
