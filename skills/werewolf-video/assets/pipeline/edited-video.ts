import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { clipVoiceProfile, type Clip, type Script, type TimedClip, type VoiceCatalog } from './project';
import { assertPlayerSources } from './integrity';
import { readPcm, wavHeader } from './audio';
import { inspectAudio } from './audio-inspection';
import { effectiveAudioAlignment } from './audio-alignment';
import { captionsFromWords, captionContent, sourceCaptionWords, srtDocument } from './timeline';
import { wrapEnglishCaption } from './english-captions';
import { avatarWaveFrame, isPlayerSpeech, verticalScene, type StoryCard } from './vertical-scene';
import { createSceneRenderer, sceneVersion } from './scene';
import { readJob } from './compile-edit';
import { encodingSettings, videoEncodingArgs } from './encoding';
import { sceneTransition, sceneFadeFilters } from './transitions';

const require = createRequire(import.meta.url);
const { createCanvas, loadImage } = require(process.env.VIDEO_CANVAS_MODULE || '@napi-rs/canvas');
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const version = 'edited-video-v3-scene-cuts-upload';
type Cue = { text: string; start: number; end: number };
type SourceItem = { kind: 'source'; id: string; sourceClipId: string; wordStart: number; wordEnd: number; quote: string; audioSha256: string; timingSha256?: string; storyCard?: StoryCard };
type NarrationItem = { kind: 'narration'; id: string; text: string; afterSourceSeq: number; storyCard?: StoryCard };
type Item = SourceItem | NarrationItem;
interface Selection { roomId: string; sourceSha256: string; reviewed: boolean; theme: string; items: Item[]; review?: unknown }
interface NarrationClip { id: string; text: string; audioFile: string; audioSha256: string; model: string; voice: string; afterSourceSeq: number }
interface NarrationManifest { roomId: string; sourceSha256: string; clips: NarrationClip[] }
interface Prepared { item: Item; clip: Clip; pcm: Int16Array; frames: number; captions: Cue[]; audioSha256: string; audioFile: string; model: string; voice: string; alignment: unknown; cut?: unknown }
const within = (parent: string, child: string) => { const r = relative(parent, child); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
/** Preserve word times while assigning only adjacent original punctuation to the excerpt. */
export function excerptSourceWords<T extends { text: string }>(source: string, mapped: T[], startWord: number, endWord: number, quote: string) {
  assert(mapped.map(w => w.text).join('') === source, 'Mapped words differ from source text');
  assert(Number.isInteger(startWord) && Number.isInteger(endWord) && startWord >= 0 && endWord > startWord && endWord <= mapped.length, 'Invalid word range');
  const chars = Array.from(source), rawStart = mapped.slice(0, startWord).reduce((n, w) => n + Array.from(w.text).length, 0);
  const rawEnd = rawStart + mapped.slice(startWord, endWord).reduce((n, w) => n + Array.from(w.text).length, 0);
  const spoken = (c: string) => /[\p{L}\p{N}]/u.test(c);
  let maxStart = rawStart; while (maxStart < rawEnd && !spoken(chars[maxStart])) maxStart++;
  let minEnd = rawEnd; while (minEnd > rawStart && !spoken(chars[minEnd - 1])) minEnd--;
  let maxEnd = rawEnd; while (maxEnd < chars.length && !spoken(chars[maxEnd])) maxEnd++;
  const length = Array.from(quote).length; let charStart = -1, charEnd = -1;
  for (let a = rawStart; a <= maxStart; a++) { const b = a + length; if (b >= minEnd && b <= maxEnd && chars.slice(a, b).join('') === quote) { charStart = a; charEnd = b; break; } }
  assert(charStart >= 0, 'Quote differs from word range');
  const words = mapped.slice(startWord, endWord).map(w => ({ ...w }));
  if (words.length === 1) words[0].text = chars.slice(charStart, charEnd).join('');
  else {
    const firstEnd = rawStart + Array.from(words[0].text).length;
    const lastStart = rawEnd - Array.from(words.at(-1)!.text).length;
    words[0].text = chars.slice(charStart, firstEnd).join('');
    words.at(-1)!.text = chars.slice(lastStart, charEnd).join('');
  }
  assert.equal(words.map(w => w.text).join(''), quote, 'Excerpt reconstruction failed');
  return { words, charStart, charEnd, rawStart, rawEnd, edgePunctuationFromSource: { removedStart: chars.slice(rawStart, charStart).join(''), removedEnd: chars.slice(charEnd, rawEnd).join(''), addedEnd: chars.slice(rawEnd, charEnd).join('') } };
}
function storyCheck(story: StoryCard | undefined, script: Script) {
  if (!story) return;
  assert(typeof story.headline === 'string' && story.headline.trim() && story.headline.length <= 100, 'Invalid story headline');
  assert(story.detail === undefined || (typeof story.detail === 'string' && story.detail.length <= 180), 'Invalid story detail');
  assert(story.focusSeats === undefined || (Array.isArray(story.focusSeats) && story.focusSeats.length <= 3 && new Set(story.focusSeats).size === story.focusSeats.length && story.focusSeats.every(n => Number.isInteger(n) && script.cast.some(c => c.seat === n))), 'Invalid story focus seats');
}
function ass(cues: Cue[], format: 'vertical' | 'horizontal', phase: string) {
  const canvas = createCanvas(4, 4), g = canvas.getContext('2d');
  const width = format === 'vertical' ? 900 : 1380, font = format === 'vertical' ? 54 : 36;
  const at = (t: number) => { const n = Math.round(t * 100); return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, '0')}:${String(Math.floor(n / 100) % 60).padStart(2, '0')}.${String(n % 100).padStart(2, '0')}`; };
  const body = cues.map(c => {
    let lines = wrapEnglishCaption(c.text.trim(), format === 'vertical' ? 34 : 54).split('\n');
    g.font = `bold ${font}px Arial`;
    if (format === 'vertical' && lines.some((l: string) => g.measureText(l).width > width)) {
      lines = lines.flatMap((l: string) => g.measureText(l).width > width ? wrapEnglishCaption(l, 30).split('\n') : [l]);
    }
    if (lines.length > 3) {
      const words = c.text.trim().split(/\s+/); let best: string[] = [c.text.trim()], bestWidth = Infinity;
      for (let a = 1; a < words.length; a++) for (let b = a + 1; b < words.length; b++) {
        const candidate = [words.slice(0, a).join(' '), words.slice(a, b).join(' '), words.slice(b).join(' ')];
        const maximum = Math.max(...candidate.map(l => g.measureText(l).width));
        if (maximum < bestWidth) { best = candidate; bestWidth = maximum; }
      }
      lines = best;
    }
    const longest = Math.max(...lines.map((l: string) => g.measureText(l).width), 1);
    const size = Math.min(font, Math.floor(font * width / longest));
    assert(size >= 24 && lines.length <= 3, 'Caption cannot fit on screen');
    const content = lines.join('\\N').replace(/[{}]/g, '').replace(/\r/g, '');
    return `Dialogue: 0,${at(c.start)},${at(c.end)},Default,,0,0,0,,{\\fs${size}\\pos(${format === 'vertical' ? '540,1500' : '1159,998'})}${content}`;
  }).join('\n');
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${format === 'vertical' ? 1080 : 1920}\nPlayResY: ${format === 'vertical' ? 1920 : 1080}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Arial,${font},${format === 'horizontal' && phase !== 'night' ? '&H00363E26' : '&H00FFFFFF'},&H00FFFFFF,${format === 'horizontal' && phase !== 'night' ? '&H00E7F5FB' : format === 'horizontal' ? '&H00351E10' : '&H00101010'},&H00000000,-1,0,0,0,100,100,0,0,1,${format === 'horizontal' ? (phase === 'night' ? 2 : 1) : 4},${format === 'horizontal' && phase !== 'night' ? 0 : 1},5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${body}\n`;
}
async function run(args: string[], cwd: string) {
  return await new Promise<string>((done, fail) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '';
    child.stdout.on('data', b => { log = (log + b).slice(-10000); }); child.stderr.on('data', b => { log = (log + b).slice(-10000); });
    child.on('error', fail); child.on('close', code => code === 0 ? done(log) : fail(Error(`ffmpeg exited ${code}: ${log}`)));
  });
}
async function renderWave(args: string[], cwd: string, pcm: Int16Array, frames: number) {
  const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let log = ''; child.stderr.on('data', b => { log = (log + b).slice(-10000); });
  let error: Error | undefined; child.on('error', e => { error = e; }); child.stdin.on('error', e => { error = e; });
  const ended = new Promise<void>((ok, fail) => { child.once('error', fail); child.once('close', code => code === 0 ? ok() : fail(Error(`ffmpeg exited ${code}: ${log}`))); });
  void ended.catch(() => {});
  try {
    for (let i = 0; i < frames; i++) {
      if (error) throw error;
      await new Promise<void>((ok, fail) => child.stdin.write(avatarWaveFrame(pcm, i), e => e ? fail(e) : ok()));
    }
    child.stdin.end(); await ended;
  } catch (e) { child.kill(); await ended.catch(() => {}); throw e; }
}
async function landscape(image: Buffer, story: StoryCard | undefined, script: Script) {
  const canvas = createCanvas(1920, 1080), g = canvas.getContext('2d'); g.drawImage(await loadImage(image), 0, 0);
  g.fillStyle = '#172a31'; g.beginPath(); g.roundRect(1434, 130, 454, 790, 26); g.fill();
  const paragraph = (value: string, x: number, y: number, max: number, size: number, color: string) => {
    g.font = `bold ${size}px Arial`; g.fillStyle = color; let line = '';
    for (const word of value.split(/\s+/)) { const next = line ? `${line} ${word}` : word; if (line && g.measureText(next).width > max) { g.fillText(line, x, y); y += size * 1.35; line = word; } else line = next; }
    if (line) { g.fillText(line, x, y); y += size * 1.35; } return y;
  };
  let y = 200; y = paragraph(story?.headline ?? 'Match highlights', 1460, y, 400, 33, '#f4d795') + 25;
  if (story?.detail) y = paragraph(story.detail, 1460, y, 400, 25, '#e3ece7') + 36;
  for (const n of story?.focusSeats ?? []) { const c = script.cast.find(p => p.seat === n)!; y = paragraph(`${n} · ${c.name} · ${c.roleName}`, 1460, y, 400, 24, '#f4d795') + 12; }
  return canvas.toBuffer('image/png') as Buffer;
}
export async function makeEditedVideo(sourcePath: string, selectionPath: string, narrationManifestPath: string | undefined, outputPath: string, format: 'vertical' | 'horizontal', encoder: 'cpu' | 'gpu', options?: { validateOnly?: boolean }) {
  const sourceDir = resolve(sourcePath), output = resolve(outputPath);
  assert(!within(sourceDir, output) && !within(output, sourceDir), 'Output must be separate from source');
  assert(format === 'vertical' || format === 'horizontal'); assert(encoder === 'cpu' || encoder === 'gpu');
  const selectionBytes = await readFile(selectionPath), sourceBytes = await readFile(join(sourceDir, 'source.json'));
  const narrationBytes = narrationManifestPath ? await readFile(narrationManifestPath) : Buffer.from(JSON.stringify({ roomId: JSON.parse(sourceBytes.toString()).roomId, sourceSha256: hash(sourceBytes), clips: [] }));
  const selection = JSON.parse(selectionBytes.toString()) as Selection, narration = JSON.parse(narrationBytes.toString()) as NarrationManifest;
  const source = JSON.parse(sourceBytes.toString()) as Script, script = JSON.parse(await readFile(join(sourceDir, 'script.json'), 'utf8')) as Script;
  const clips = JSON.parse(await readFile(join(sourceDir, 'clips.json'), 'utf8')) as Clip[], voices = JSON.parse(await readFile(join(sourceDir, 'voices.json'), 'utf8')) as VoiceCatalog;
  const bound = JSON.parse(await readFile(join(sourceDir, 'avatar-theme.json'), 'utf8'));
  assert(source.perspective === 'god' && script.perspective === 'god' && source.status === 'ended' && script.status === 'ended', 'Only completed god projects are supported');
  assert(source.roomId === script.roomId && selection.roomId === source.roomId && narration.roomId === source.roomId && selection.sourceSha256 === hash(sourceBytes) && narration.sourceSha256 === hash(sourceBytes), 'Wrong room or source hash');
  assert(selection.reviewed === true && Array.isArray(selection.items) && selection.items.length > 0 && selection.theme === bound.theme, 'Selection or theme not reviewed');
  assert.deepEqual(script.events, source.events, 'Script changes source facts'); assertPlayerSources(source, script, clips);
  assert(Array.isArray(narration.clips)); assert(new Set(narration.clips.map(c => c.id)).size === narration.clips.length, 'Duplicate narration');
  const speakerBindings = new Set(narration.clips.map(c => `${c.model}\0${c.voice}`)); assert(speakerBindings.size <= 1, 'Narration must use one model and voice');
  assert(narration.clips.every(c => c.voice !== voices.profiles.judge?.voice), 'Narration and judge must use distinct voices');
  const selected: Prepared[] = []; let lastIndex = -1, lastSeq = -1, totalFrames = 0; const ids = new Set<string>();
  for (const item of selection.items) {
    assert(typeof item.id === 'string' && item.id && !ids.has(item.id), 'Duplicate or invalid item'); ids.add(item.id); storyCheck(item.storyCard, script);
    let clip: Clip, file: string, expectedText: string, expectedHash: string, model: string, voice: string;
    if (item.kind === 'source') {
      const index = clips.findIndex(c => c.id === item.sourceClipId); assert(index > lastIndex, 'Unknown, duplicate or out-of-order source clip'); lastIndex = index;
      clip = clips[index]; assert(clip.sourceSeq >= lastSeq, 'Source sequence goes backwards'); lastSeq = clip.sourceSeq;
      file = join(sourceDir, 'audio', `${clip.id}.wav`); expectedText = clip.spokenText; expectedHash = item.audioSha256;
      model = voices.model; voice = clipVoiceProfile(voices, clip, source.locale ?? 'zh-CN').voice;
    } else {
      assert(item.kind === 'narration' && Number.isInteger(item.afterSourceSeq) && item.afterSourceSeq >= lastSeq, 'Invalid or out-of-order narration anchor');
      const event = script.events.find(e => e.sourceSeq === item.afterSourceSeq); assert(event, 'Narration anchor does not exist'); lastSeq = item.afterSourceSeq;
      const entry = narration.clips.find(c => c.id === item.id); assert(entry && entry.text === item.text && entry.afterSourceSeq === item.afterSourceSeq, 'Narration manifest mismatch');
      assert(typeof entry.model === 'string' && entry.model && typeof entry.voice === 'string' && entry.voice, 'Narration model or voice missing');
      assert(narrationManifestPath, 'Narration manifest is required for narration');
      file = resolve(dirname(resolve(narrationManifestPath)), entry.audioFile); expectedText = item.text; expectedHash = entry.audioSha256; model = entry.model; voice = entry.voice;
      clip = { id: item.id, sourceSeq: event.sourceSeq, type: 'editorial.narration', speaker: 'Narrator', voiceKey: 'commentator', text: item.text, spokenText: item.text, visibility: 'public', data: { replayThrough: event.sourceSeq }, day: event.day, phase: event.phase, chapter: script.chapters.find(chapter => chapter.day === event.day && chapter.phase === event.phase)?.title ?? `${event.phase} ${event.day}`, part: 1, parts: 1, audioFile: file };
    }
    const bytes = await readFile(file), actualHash = hash(bytes); assert(/^[a-f0-9]{64}$/.test(expectedHash) && actualHash === expectedHash, 'Audio hash mismatch');
    const meta = JSON.parse(await readFile(file + '.json', 'utf8')); assert.equal(meta.model, model, 'Audio model mismatch'); assert.equal(meta.voice, voice, 'Audio voice mismatch'); assert.equal(meta.text, expectedText, 'Audio text mismatch'); assert.equal(meta.bytes, bytes.length, 'Audio byte count mismatch');
    const { samples, sampleRate } = await readPcm(file); assert.equal(sampleRate, 24000, 'Expected 24 kHz PCM'); assert.equal(inspectAudio(samples, sampleRate).issues.length, 0, 'Audio waveform failed inspection');
    const choice = await effectiveAudioAlignment(file, meta, source.locale ?? 'zh-CN'); const mapped = sourceCaptionWords(choice.meta, source.locale ?? 'zh-CN');
    assert(mapped.length && mapped.every((w, i) => Number.isFinite(w.begin_time) && Number.isFinite(w.end_time) && w.begin_time >= 0 && w.end_time > w.begin_time && w.end_time <= samples.length / 24 + 1 && (!i || w.begin_time >= mapped[i - 1].begin_time && w.end_time >= mapped[i - 1].end_time)), 'Invalid word timing');
    let pcm = samples, captionMeta = choice.meta, cut: unknown;
    if (item.kind === 'source') {
      if (item.timingSha256 !== undefined) assert.equal(item.timingSha256, hash(JSON.stringify(mapped)), 'Word timing hash mismatch');
      const { wordStart: a, wordEnd: b } = item; assert(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= mapped.length, 'Invalid word range');
      const first = mapped[a], last = mapped[b - 1]; assert((a === 0 || mapped[a - 1].end_time <= first.begin_time) && (b === mapped.length || last.end_time <= mapped[b].begin_time), 'Range overlaps adjacent words');
      const extracted = excerptSourceWords(clip.spokenText, mapped, a, b, item.quote); const quote = item.quote;
      const start = Math.max(0, Math.ceil(Math.max(a ? mapped[a - 1].end_time : 0, first.begin_time - 40) * 24));
      const end = Math.min(samples.length, Math.floor(Math.min(b < mapped.length ? mapped[b].begin_time : samples.length / 24, last.end_time + 40) * 24)); assert(end > start, 'Empty word range');
      pcm = samples.slice(start, end); const words = extracted.words.map(w => ({ ...w, begin_time: w.begin_time - start / 24, end_time: w.end_time - start / 24 }));
      captionMeta = { ...choice.meta, text: quote, sentences: [{ index: 0, text: quote, words }] }; cut = { wordStart: a, wordEnd: b, firstBeginMs: first.begin_time, lastEndMs: last.end_time, sampleStart: start, sampleEnd: end, charStart: extracted.charStart, charEnd: extracted.charEnd, edgePunctuationFromSource: extracted.edgePunctuationFromSource };
    }
    const captions = captionsFromWords(captionMeta, pcm.length / 24000, source.locale ?? 'zh-CN'); assert.equal(captionContent(captions.map(c => c.text).join('')), captionContent(item.kind === 'source' ? item.quote : item.text), 'Caption text mismatch');
    const frames = Math.ceil(pcm.length / 800 + 5); totalFrames += frames; selected.push({ item, clip, pcm, frames, captions, audioSha256: actualHash, audioFile: file, model, voice, alignment: choice.summary ?? { method: 'provider' }, cut });
  }
  assert(totalFrames / 30 <= 720, 'Selection exceeds 720 seconds');
  if (options?.validateOnly) { console.log(JSON.stringify({ validated: selected.length, frames: totalFrames, durationSeconds: totalFrames / 30 })); return; }
  const encoding = encodingSettings({ ...process.env, VIDEO_ENCODER: encoder === 'gpu' ? 'h264_nvenc' : 'libx264', VIDEO_REQUIRE_GPU: encoder === 'gpu' ? '1' : '0' });
  const scenes = selected.map(c => ({ ...c.clip, frames: c.frames }));
  const identity = hash(JSON.stringify({ version, sceneVersion, format, encoder, encoding, source: hash(sourceBytes), selection: hash(selectionBytes), narration: hash(narrationBytes), clips: selected.map(c => ({ audio: c.audioSha256, alignment: c.alignment, cut: c.cut })) }));
  await mkdir(output, { recursive: true }); const identityFile = join(output, 'identity.json');
  try { const old = JSON.parse(await readFile(identityFile, 'utf8')); assert.equal(old.identity, identity, 'Output directory belongs to different inputs or settings'); }
  catch (e: any) { if (e.code !== 'ENOENT') throw e; const existing = await import('node:fs/promises').then(fs => fs.readdir(output)); assert(existing.length === 0, 'Output directory is not empty'); await writeFile(identityFile, JSON.stringify({ identity }, null, 2), { flag: 'wx' }); }
  await mkdir(join(output, 'segments'), { recursive: true }); await mkdir(join(output, 'output'), { recursive: true });
  await writeFile(join(output, 'encoding-settings.json'), JSON.stringify(encoding, null, 2));
  const draw = format === 'horizontal' ? await createSceneRenderer(script, { theme: selection.theme, viewLabel: 'GOD VIEW · HIGHLIGHTS', hideAudioPill: true }) : undefined;
  const parts: Buffer[] = [], allCues: Cue[] = [], mapping: unknown[] = []; let startFrame = 0;
  for (const [i, c] of selected.entries()) {
    const stem = String(i).padStart(3, '0'), image = format === 'vertical' ? await verticalScene(c.clip, selection.theme, script, c.item.storyCard) : await landscape(await draw!({ ...c.clip, frames: c.frames, startFrame, audioDuration: c.pcm.length / 24000, audioMeta: {} as TimedClip['audioMeta'], captions: c.captions, envelope: [] }), c.item.storyCard, script);
    const subtitles = ass(c.captions, format, c.clip.phase), key = hash(Buffer.concat([image, Buffer.from(subtitles), Buffer.from(identity), Buffer.from(JSON.stringify({ frames: c.frames, item: c.item }))]));
    const plate = `segments/${stem}.png`, sub = `segments/${stem}.ass`, segment = `segments/${stem}.mp4`, marker = join(output, segment + '.json');
    await writeFile(join(output, plate), image); await writeFile(join(output, sub), subtitles);
    let cached = false; try { const saved = JSON.parse(await readFile(marker, 'utf8')); cached = saved.key === key && saved.sha256 === hash(await readFile(join(output, segment))); } catch { /* missing or stale */ }
    if (!cached) {
      const partial = `segments/${stem}.partial.mp4`, fade = [`ass=${sub}`, ...sceneFadeFilters(sceneTransition(scenes[i], scenes[i - 1], scenes[i + 1]), c.frames)].join(',');
      const codec = videoEncodingArgs(encoding);
      const base = ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', plate];
      const wave = format === 'vertical' && isPlayerSpeech(c.clip);
      const visual = wave ? ['-f', 'image2pipe', '-framerate', '30', '-vcodec', 'png', '-i', 'pipe:0', '-filter_complex_threads', '1', '-filter_complex', `[0:v][1:v]overlay=130:370:shortest=1,${fade}[v]`, '-map', '[v]'] : ['-vf', fade];
      const args = [...base, ...visual, '-an', '-frames:v', String(c.frames), ...codec, '-r', '30', partial];
      if (wave) await renderWave(args, output, c.pcm, c.frames); else await run(args, output);
      await rename(join(output, partial), join(output, segment)); await writeFile(marker, JSON.stringify({ key, sha256: hash(await readFile(join(output, segment))) }));
    }
    const audio = Buffer.alloc(c.frames * 1600); for (let j = 0; j < c.pcm.length; j++) audio.writeInt16LE(c.pcm[j], j * 2); parts.push(audio);
    allCues.push(...c.captions.map(cue => ({ ...cue, start: cue.start + startFrame / 30, end: cue.end + startFrame / 30 })));
    mapping.push({ ...c.item, audioSha256: c.audioSha256, audioFile: c.audioFile, model: c.model, voice: c.voice, startFrame, frames: c.frames, sampleCount: c.pcm.length, alignment: c.alignment, cut: c.cut }); startFrame += c.frames;
    console.log(JSON.stringify({ rendered: i + 1, total: selected.length, id: c.item.id, cached }));
  }
  const pcm = Buffer.concat(parts); await writeFile(join(output, 'master.wav'), Buffer.concat([wavHeader(pcm.length / 2, 24000), pcm]));
  await writeFile(join(output, 'segments.ffconcat'), 'ffconcat version 1.0\n' + selected.map((_, i) => `file 'segments/${String(i).padStart(3, '0')}.mp4'`).join('\n') + '\n');
  await writeFile(join(output, 'output', 'subtitles.srt'), srtDocument(allCues));
  const final = `output/highlights-${format}.mp4`, partialFinal = `output/highlights-${format}.partial.mp4`;
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'segments.ffconcat', '-i', 'master.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', `${encoding.audioKbps}k`, '-metadata:s:a:0', 'language=eng', '-movflags', '+faststart', partialFinal], output);
  await rename(join(output, partialFinal), join(output, final));
  const probe = await new Promise<any>((ok, fail) => { const p = spawn(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', final], { cwd: output, windowsHide: true }); let text = '', err = ''; p.stdout.on('data', b => { text += b; }); p.stderr.on('data', b => { err += b; }); p.on('error', fail); p.on('close', code => code === 0 ? ok(JSON.parse(text)) : fail(Error(err))); });
  const video = probe.streams.find((s: any) => s.codec_type === 'video'), audio = probe.streams.find((s: any) => s.codec_type === 'audio');
  assert(video.width === (format === 'vertical' ? 1080 : 1920) && video.height === (format === 'vertical' ? 1920 : 1080) && Number(video.nb_frames) === totalFrames && video.r_frame_rate === '30/1', 'Video frame verification failed');
  assert(audio?.tags?.language === 'eng' && Math.abs(Number(video.duration) - Number(audio.duration)) <= 1 / 30 + .05, 'Audio/video verification failed');
  await writeFile(join(output, 'output', 'source-map.json'), JSON.stringify({ roomId: source.roomId, sourceSha256: hash(sourceBytes), identity, clips: mapping }, null, 2));
  await writeFile(join(output, 'output', 'verification.json'), JSON.stringify({ identity, format, encoding, frames: totalFrames, sampleCount: pcm.length / 2, width: video.width, height: video.height, fps: 30, encoder, audioLanguage: 'eng', videoSha256: hash(await readFile(join(output, final))), bytes: (await stat(join(output, final))).size, audioGain: 1, transition: 'hard cuts within scenes; four-frame fades only at phase or chapter boundaries; 5 frames silence padding', subjectiveListening: 'not-checked' }, null, 2));
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/edited-video.ts')) {
  const opt = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
  const jobPath = opt('job');
  if (jobPath) {
    assert(process.argv.slice(2).every(x => x === `--job=${jobPath}` || x === '--validate-only') && process.argv.slice(2).filter(x => x.startsWith('--job=')).length === 1, 'Job cannot be mixed with other flags');
    const { job, pathAt } = await readJob(jobPath, ['sourceProject', 'selection', 'narrationManifest', 'outputDir', 'format', 'encoder']);
    const source = pathAt('sourceProject')!, selection = pathAt('selection')!, narration = pathAt('narrationManifest', false), output = pathAt('outputDir')!;
    assert((job.format === 'vertical' || job.format === 'horizontal') && (job.encoder === 'cpu' || job.encoder === 'gpu'), 'Invalid format or encoder');
    await makeEditedVideo(source, selection, narration, output, job.format, job.encoder, { validateOnly: process.argv.includes('--validate-only') });
  } else {
    const source = opt('source-project'), selection = opt('selection'), narration = opt('narration-manifest'), output = opt('output-dir'), format = opt('format'), encoder = opt('encoder');
    assert(source && selection && narration && output && (format === 'vertical' || format === 'horizontal') && (encoder === 'cpu' || encoder === 'gpu'), 'Required: --source-project --selection --narration-manifest --output-dir --format=vertical|horizontal --encoder=cpu|gpu');
    await makeEditedVideo(source, selection, narration, output, format, encoder, { validateOnly: process.argv.includes('--validate-only') });
  }
}
