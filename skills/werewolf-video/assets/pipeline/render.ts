import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSceneRenderer, sceneVersion } from './scene';
import { palettes } from './palette';
import { createRuleStrip, RULE_SCROLL_SPEED, RULE_VIEW } from './rule-strip';
import { voteCardLayout } from './geometry';
import { projectDir, ffmpeg, FPS, type Script, type TimedClip } from './project';
import { encodingSettings, videoEncodingArgs } from './encoding';

const timeline = JSON.parse(await readFile(`${projectDir}/timeline.json`, 'utf8')) as { frames: number; duration: number; clips: TimedClip[] };
const script = JSON.parse(await readFile(`${projectDir}/script.json`, 'utf8')) as Script;
for (const folder of ['plates', 'segments', 'output']) await mkdir(`${projectDir}/${folder}`, { recursive: true });
const ruleStrips = { day: await createRuleStrip(script, 'day'), night: await createRuleStrip(script, 'night') };
for (const phase of ['day', 'night'] as const) await writeFile(`${projectDir}/plates/rules-${phase}.png`, ruleStrips[phase].png);
const only = process.argv.find((s) => s.startsWith('--only='))?.slice(7);
const preview = process.argv.includes('--plates-only');
const clips = only ? timeline.clips.filter((c) => c.id === only) : timeline.clips;
if (!clips.length) throw Error('No requested clip');
const settings = encodingSettings(), encoder = settings.encoder;
const renderStarted = Date.now();
const encodingIdentity = { ...settings, format: 'native-compact-v1' };
await writeFile(`${projectDir}/encoding-settings.json`, JSON.stringify(encodingIdentity, null, 2));
async function run(args: string[], logFile: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-y', ...args], { cwd: projectDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (b) => { output = (output + b).slice(-12000); }); child.stderr.on('data', (b) => { output = (output + b).slice(-12000); });
    child.on('error', reject); child.on('close', async (code) => { await writeFile(logFile, output); code === 0 ? resolve() : reject(Error(`Video encoder exited ${code}: ${output.slice(-1800)}`)); });
  });
}
let cursor = 0, complete = 0;
async function worker() {
  const draw = await createSceneRenderer(script);
  while (cursor < clips.length) {
    const clip = clips[cursor++], image = await draw(clip), plate = join(projectDir, 'plates', `${clip.id}.jpg`);
    await writeFile(plate, image);
    if (preview) { console.log(`plate ${clip.id}`); continue; }
    const ass = await readFile(`${projectDir}/subtitles/${clip.id}.ass`, 'utf8');
    const rules = ruleStrips[clip.phase === 'night' ? 'night' : 'day'];
    const cacheKey = createHash('sha256').update(image).update(rules.png).update(ass).update(clip.audioMeta.cacheKey).update(sceneVersion).update(JSON.stringify(encodingIdentity)).update(JSON.stringify({ frames: clip.frames, startFrame: clip.startFrame, ruleSpeed: RULE_SCROLL_SPEED, ruleView: RULE_VIEW })).digest('hex');
    const output = `${projectDir}/segments/${clip.id}.mp4`, marker = output + '.json';
    let cached = false;
    try { cached = JSON.parse(await readFile(marker, 'utf8')).cacheKey === cacheKey && (await stat(output)).size > 1000; } catch { /* Render missing or stale segment. */ }
    if (!cached) {
      const waveColor = (clip.phase === 'night' ? palettes.night : palettes.day).wave.replace('#', '0x');
      const waveY = clip.type === 'vote.result' ? voteCardLayout(clip.data.rows?.length ?? 0).waveY + 4 : 592;
      const filter = `[1:a]apad=pad_dur=1,showwaves=s=230x32:mode=cline:rate=${FPS}:colors=${waveColor}:scale=sqrt:draw=full,format=rgba,colorkey=0x000000:0.01:0.01[wave];[2:v]crop=${RULE_VIEW.width}:${RULE_VIEW.height}:0:'mod((t+${clip.startFrame / FPS})*${RULE_SCROLL_SPEED},${rules.cycleHeight})'[rules];[0:v][rules]overlay=${RULE_VIEW.x}:${RULE_VIEW.y}:shortest=1[board];[board][wave]overlay=599:${waveY}:shortest=1,ass=subtitles/${clip.id}.ass[v]`;
      const videoArgs = videoEncodingArgs(settings);
      const encode = (options: string[]) => run(['-threads', '1', '-loop', '1', '-framerate', String(FPS), '-i', `plates/${clip.id}.jpg`, '-i', `audio-normalized/${clip.id}.wav`, '-loop', '1', '-framerate', String(FPS), '-i', `plates/rules-${clip.phase === 'night' ? 'night' : 'day'}.png`, '-filter_complex_threads', '1', '-filter_complex', filter,
        '-map', '[v]', '-an', '-frames:v', String(clip.frames), '-r', String(FPS), ...options, `segments/${clip.id}.partial.mp4`], output + '.log');
      let actualEncoder = encoder;
      const started = Date.now();
      try { await encode(videoArgs); }
      catch (error) {
        if (encoder !== 'h264_nvenc' || settings.strictGpu) throw error;
        console.log(JSON.stringify({ clip: clip.id, fallback: 'libx264', reason: 'Hardware encoder unavailable; audio and completed segments retained' }));
        actualEncoder = 'libx264'; await encode(videoEncodingArgs(settings, 'libx264'));
      }
      await rename(output.replace(/\.mp4$/, '.partial.mp4'), output);
      await writeFile(marker, JSON.stringify({ cacheKey, frames: clip.frames, encoder: actualEncoder, encoding: encodingIdentity, elapsedSeconds: (Date.now() - started) / 1000, bytes: (await stat(output)).size }));
    }
    complete++; console.log(JSON.stringify({ rendered: complete, total: clips.length, clip: clip.id, cached }));
    await writeFile(`${projectDir}/render-progress.json`, JSON.stringify({ completed: complete, total: clips.length, lastClip: clip.id,
      elapsedSeconds: (Date.now() - renderStarted) / 1000, updatedAt: new Date().toISOString() }));
  }
}
// Each worker owns its canvas, so concurrent encodes cannot change another plate.
// Windows charges GPU allocations against system commit; a single encoder is the safe default.
const jobs = Math.max(1, Math.min(2, Number(process.env.VIDEO_JOBS) || 1));
const workers = await Promise.allSettled(Array.from({ length: jobs }, () => worker()));
for (const result of workers) if (result.status === 'rejected') throw result.reason;
if (preview || only) process.exit(0);
for (const clip of timeline.clips) if (!existsSync(`${projectDir}/segments/${clip.id}.mp4`)) throw Error(`Missing segment ${clip.id}`);
await writeFile(`${projectDir}/segments.ffconcat`, 'ffconcat version 1.0\n' + timeline.clips.map((c) => `file 'segments/${c.id}.mp4'`).join('\n') + '\n');
let chapters = ';FFMETADATA1\ntitle=狼人杀最新一局 · 上帝视角\ncomment=真实对局记录重建，Qwen TTS人工智能配音\n';
for (let i = 0; i < timeline.clips.length; i++) {
  const clip = timeline.clips[i]; if (i && timeline.clips[i - 1].chapter === clip.chapter) continue;
  const next = timeline.clips.slice(i + 1).find((c) => c.chapter !== clip.chapter);
  chapters += `[CHAPTER]\nTIMEBASE=1/30\nSTART=${clip.startFrame}\nEND=${next?.startFrame ?? timeline.frames}\ntitle=${clip.chapter}\n`;
}
await writeFile(`${projectDir}/chapters.txt`, chapters);
await run(['-f', 'concat', '-safe', '0', '-i', 'segments.ffconcat', '-i', 'master.wav', '-i', 'chapters.txt',
  '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '2', '-map_chapters', '2', '-c:v', 'copy', '-c:a', 'aac', '-b:a', `${settings.audioKbps}k`,
  '-metadata:s:a:0', 'language=zho', '-movflags', '+faststart', 'output/latest-match.partial.mp4'], `${projectDir}/output/mux.log`);
await rename(`${projectDir}/output/latest-match.partial.mp4`, `${projectDir}/output/latest-match.mp4`);
await writeFile(`${projectDir}/output/render-report.json`, JSON.stringify({ ...encodingIdentity, elapsedSeconds: (Date.now() - renderStarted) / 1000,
  durationSeconds: timeline.duration, bytes: (await stat(`${projectDir}/output/latest-match.mp4`)).size, compactFromFirstEncode: true, videoReencodedAtMux: false }, null, 2));
console.log(JSON.stringify({ video: `${projectDir}/output/latest-match.mp4`, duration: timeline.duration, frames: timeline.frames }));
