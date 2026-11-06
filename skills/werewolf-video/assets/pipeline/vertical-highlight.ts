import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { buildClips, clipVoiceProfile, type Clip, type Script, type VoiceCatalog } from './project';
import { assertPlayerSources } from './integrity';
import { readPcm, wavHeader } from './audio';
import { inspectAudio } from './audio-inspection';
import { effectiveAudioAlignment } from './audio-alignment';
import { captionsFromWords, captionContent, sourceCaptionWords, srtDocument } from './timeline';
import { isPlayerSpeech, avatarWaveFrame, verticalScene, type StoryCard } from './vertical-scene';
import { encodingSettings, videoEncodingArgs } from './encoding';
import { sceneTransition, sceneFadeFilters } from './transitions';

const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
interface Item { id: string; quote: string; factReview: string; audioReview: string; excerptNote: string; audioSha256: string; wordStart?: number; wordEnd?: number; story?: StoryCard }
interface Selection { roomId: string; sourceSha256: string; reviewed: boolean; theme: string; clips: Item[] }
function within(parent: string, child: string) { const r = relative(parent, child); return !r || (!r.startsWith('..') && !isAbsolute(r)); }
function ass(cues: { text: string; start: number; end: number }[]) {
  const time = (t: number) => { const n = Math.round(t * 100); return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, '0')}:${String(Math.floor(n / 100) % 60).padStart(2, '0')}.${String(n % 100).padStart(2, '0')}`; };
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Arial,62,&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,-1,0,0,0,100,100,0,0,1,4,1,2,90,90,350,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + cues.map(c => `Dialogue: 0,${time(c.start)},${time(c.end)},Default,,0,0,0,,${c.text.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\n/g, ' ')}`).join('\n') + '\n';
}
async function run(command: string, args: string[], cwd: string) {
  return await new Promise<string>((ok, fail) => {
    const child = spawn(command, args, { cwd, windowsHide: true }); let out = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { out += b; });
    child.on('error', fail); child.on('close', code => code === 0 ? ok(out) : fail(Error(`${command} exited ${code}: ${out.slice(-3000)}`)));
  });
}
export async function makeVertical(sourcePath: string, selectionPath: string, outputPath: string, encoder: 'cpu' | 'gpu') {
  const sourceDir = resolve(sourcePath), output = resolve(outputPath);
  assert(!within(sourceDir, output) && !within(output, sourceDir), 'Output must be separate from source project');
  assert(encoder === 'cpu' || encoder === 'gpu', 'Expected cpu or gpu encoder');
  const selection = JSON.parse(await readFile(resolve(selectionPath), 'utf8')) as Selection;
  const sourceBytes = await readFile(join(sourceDir, 'source.json'));
  const source = JSON.parse(sourceBytes.toString()) as Script;
  const script = JSON.parse(await readFile(join(sourceDir, 'script.json'), 'utf8')) as Script;
  const clips = JSON.parse(await readFile(join(sourceDir, 'clips.json'), 'utf8')) as Clip[];
  const voices = JSON.parse(await readFile(join(sourceDir, 'voices.json'), 'utf8')) as VoiceCatalog;
  const bound = JSON.parse(await readFile(join(sourceDir, 'avatar-theme.json'), 'utf8'));
  assert(source.perspective === 'god' && script.perspective === 'god' && source.status === 'ended', 'Only completed god projects are supported');
  assert(source.roomId === script.roomId && selection.roomId === source.roomId && selection.sourceSha256 === hash(sourceBytes), 'Wrong room or source hash');
  assert(selection.reviewed === true && Array.isArray(selection.clips) && selection.clips.length > 0, 'Selection has not been reviewed');
  assert(selection.theme === bound.theme && ['campus','storybook','gufeng','fantasy','urban','future'].includes(selection.theme), 'Avatar theme mismatch');
  const expected = buildClips(script);
  assert.equal(clips.length, expected.length, 'Incomplete clips manifest');
  for (let i = 0; i < clips.length; i++) {
    const { audioFile: _a, ...a } = clips[i], { audioFile: _b, ...b } = expected[i];
    assert.deepEqual(a, b, 'Clip manifest differs from script');
  }
  assert.deepEqual(script.events, source.events, 'Script changes source facts');
  assertPlayerSources(source, script, clips);
  const chosen: { clip: Clip; pcm: Int16Array; frames: number; captions: {text: string; start: number; end: number}[]; item: Item; alignment: unknown; cut: { wordStart: number; wordEnd: number; firstBeginMs: number; lastEndMs: number; sampleStart: number; sampleEnd: number } | undefined }[] = [];
  let previous = -1, totalFrames = 0;
  for (const item of selection.clips) {
    assert(Object.keys(item).every(key => ['id', 'quote', 'factReview', 'audioReview', 'excerptNote', 'audioSha256', 'wordStart', 'wordEnd', 'story'].includes(key)), 'Only whole clips or word ranges are supported; unknown selection fields are forbidden');
    if (item.story !== undefined) {
      const s = item.story;
      assert(s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).every(key => ['headline', 'detail', 'focusSeats'].includes(key)), 'Invalid story card');
      assert(typeof s.headline === 'string' && s.headline.trim() && s.headline.length <= 80 && (s.detail === undefined || (typeof s.detail === 'string' && s.detail.length <= 120)), 'Invalid story text');
      assert(s.focusSeats === undefined || (Array.isArray(s.focusSeats) && s.focusSeats.length <= 3 && new Set(s.focusSeats).size === s.focusSeats.length && s.focusSeats.every(seat => Number.isInteger(seat) && script.cast.some(player => player.seat === seat))), 'Invalid story focus seats');
    }
    const index = clips.findIndex(c => c.id === item.id);
    assert(index > previous, 'Unknown, duplicate or out-of-order clip'); previous = index;
    const clip = clips[index], file = join(sourceDir, 'audio', `${clip.id}.wav`);
    assert(typeof item.quote === 'string' && item.quote.trim() && typeof item.factReview === 'string' && item.factReview.trim() && typeof item.audioReview === 'string' && item.audioReview.trim() && typeof item.excerptNote === 'string' && item.excerptNote.trim(), 'Missing quote or factual/excerpt review');
    const bytes = await readFile(file); assert.equal(hash(bytes), item.audioSha256, 'Audio hash mismatch');
    const meta = JSON.parse(await readFile(file + '.json', 'utf8'));
    const voice = clipVoiceProfile(voices, clip, source.locale ?? 'zh-CN');
    assert.equal(meta.voice, voice.voice, 'Audio voice differs from catalog'); assert.equal(meta.model, voices.model, 'Audio model differs from catalog');
    assert.equal(meta.text, clip.spokenText, 'Audio metadata text differs'); assert.equal(meta.bytes, bytes.length, 'Audio metadata bytes differ');
    const { samples, sampleRate } = await readPcm(file); assert.equal(sampleRate, 24000, 'Expected 24 kHz PCM');
    const inspection = inspectAudio(samples, sampleRate); assert.equal(inspection.issues.length, 0, 'Audio waveform failed inspection');
    const choice = await effectiveAudioAlignment(file, meta, source.locale ?? 'zh-CN');
    const words = choice.meta.sentences.flatMap((sentence: any) => sentence.words);
    assert(words.every((word: any) => Number.isFinite(word.begin_time) && Number.isFinite(word.end_time) && word.begin_time >= 0 && word.end_time > word.begin_time && word.end_time <= samples.length / sampleRate * 1000 + 1), 'Word timing exceeds source audio');
    const captions = captionsFromWords(choice.meta, samples.length / sampleRate, source.locale ?? 'zh-CN');
    assert.equal(captionContent(captions.map(c => c.text).join('')), captionContent(clip.spokenText), 'Caption text mismatch');
    assert(captions.every(c => c.start >= 0 && c.end <= samples.length / sampleRate + .001), 'Caption out of bounds');
    const mapped = sourceCaptionWords(choice.meta, source.locale ?? 'zh-CN');
    const hasRange = item.wordStart !== undefined || item.wordEnd !== undefined;
    let cut: { wordStart: number; wordEnd: number; firstBeginMs: number; lastEndMs: number; sampleStart: number; sampleEnd: number } | undefined;
    let selectedPcm = samples, selectedCaptions = captions;
    if (hasRange) {
      const { wordStart, wordEnd } = item;
      assert(Number.isInteger(wordStart) && Number.isInteger(wordEnd) && wordStart! >= 0 && wordEnd! > wordStart! && wordEnd! <= mapped.length, 'Invalid word range');
      const first = mapped[wordStart!], last = mapped[wordEnd! - 1];
      assert((wordStart === 0 || mapped[wordStart! - 1].end_time <= first.begin_time) && (wordEnd === mapped.length || last.end_time <= mapped[wordEnd!].begin_time), 'Word range overlaps adjacent words');
      const quoted = mapped.slice(wordStart, wordEnd).map(word => word.text).join('').trim();
      assert.equal(item.quote, quoted, 'Quote differs from word range');
      const before = wordStart === 0 ? 0 : mapped[wordStart! - 1].end_time;
      const after = wordEnd === mapped.length ? samples.length / sampleRate * 1000 : mapped[wordEnd!].begin_time;
      const sampleStart = Math.max(0, Math.ceil(Math.max(before, first.begin_time - 40) * sampleRate / 1000));
      const sampleEnd = Math.min(samples.length, Math.floor(Math.min(after, last.end_time + 40) * sampleRate / 1000));
      assert(sampleEnd > sampleStart, 'Word range has no source samples');
      cut = { wordStart: wordStart!, wordEnd: wordEnd!, firstBeginMs: first.begin_time, lastEndMs: last.end_time, sampleStart, sampleEnd };
      selectedPcm = samples.slice(sampleStart, sampleEnd);
      const offsetMs = sampleStart / sampleRate * 1000;
      const selectedWords = mapped.slice(wordStart, wordEnd).map((word, i, all) => ({ ...word,
        text: (i === 0 ? word.text.trimStart() : word.text).replace(i === all.length - 1 ? /\s+$/u : /$^/u, ''),
        begin_time: Math.max(0, word.begin_time - offsetMs), end_time: Math.min(selectedPcm.length / sampleRate * 1000, word.end_time - offsetMs) }));
      const selectedMeta = { ...choice.meta, text: quoted, sentences: [{ index: 0, text: quoted, words: selectedWords }] };
      selectedCaptions = captionsFromWords(selectedMeta, selectedPcm.length / sampleRate, source.locale ?? 'zh-CN');
      assert.equal(captionContent(selectedCaptions.map(c => c.text).join('')), captionContent(quoted), 'Range caption text mismatch');
    } else assert.equal(item.quote, clip.spokenText, 'Quote differs from full clip');
    const frames = Math.ceil((selectedPcm.length / sampleRate + .2) * 30); totalFrames += frames;
    chosen.push({ clip, pcm: selectedPcm, frames, captions: selectedCaptions, item, alignment: choice.summary ?? { method: 'provider' }, cut });
  }
  assert(totalFrames / 30 <= 120, 'Selection exceeds 120 seconds');
  const encoding = encodingSettings({ ...process.env, VIDEO_ENCODER: encoder === 'gpu' ? 'h264_nvenc' : 'libx264', VIDEO_REQUIRE_GPU: encoder === 'gpu' ? '1' : '0' });
  const scenes = chosen.map(c => ({ ...c.clip, frames: c.frames }));
  // Exclusive directory creation protects all prior artifacts, including failed attempts.
  await mkdir(output, { recursive: false }); await mkdir(join(output, 'output')); await mkdir(join(output, 'review'));
  await writeFile(join(output, 'encoding-settings.json'), JSON.stringify(encoding, null, 2));
  let start = 0; const pcmParts: Buffer[] = [], cues: {text: string; start: number; end: number}[] = [], map = [];
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i], stem = String(i).padStart(3, '0');
    const image = await verticalScene(c.clip, selection.theme, script, c.item.story); await writeFile(join(output, `${stem}.png`), image);
    await writeFile(join(output, `${stem}.ass`), ass(c.captions));
    const audio = Buffer.alloc(c.frames * 800 * 2); for (let j = 0; j < c.pcm.length; j++) audio.writeInt16LE(c.pcm[j], j * 2); pcmParts.push(audio);
    cues.push(...c.captions.map(x => ({ ...x, start: x.start + start / 30, end: x.end + start / 30 })));
    map.push({ ...c.item, startFrame: start, frames: c.frames, sampleCount: c.pcm.length, alignment: c.alignment, ...(c.cut ? { cut: c.cut } : {}) }); start += c.frames;
    const speaking = isPlayerSpeech(c.clip);
    if (speaking) {
      await mkdir(join(output, 'rings', stem), { recursive: true });
      for (let frame = 0; frame < c.frames; frame++)
        await writeFile(join(output, 'rings', stem, `${String(frame).padStart(6, '0')}.png`), avatarWaveFrame(c.pcm, frame));
    }
    const codec = videoEncodingArgs(encoding);
    const fade = [`ass=${stem}.ass`, ...sceneFadeFilters(sceneTransition(scenes[i], scenes[i - 1], scenes[i + 1]), c.frames)].join(',');
    const visual = speaking
      ? ['-framerate','30','-i',`rings/${stem}/%06d.png`,'-filter_complex',`[0:v][1:v]overlay=130:370:shortest=1,${fade}[v]`,'-map','[v]']
      : ['-vf', fade];
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner','-loglevel','error','-n','-loop','1','-framerate','30','-i',`${stem}.png`,...visual,'-frames:v',String(c.frames),...codec,'-r','30',`${stem}.mp4`], output);
    console.log(JSON.stringify({ rendered: i + 1, total: chosen.length, clip: c.clip.id }));
  }
  const pcm = Buffer.concat(pcmParts); await writeFile(join(output, 'master.wav'), Buffer.concat([wavHeader(pcm.length / 2, 24000), pcm]));
  await writeFile(join(output, 'list.ffconcat'), 'ffconcat version 1.0\n' + chosen.map((_, i) => `file '${String(i).padStart(3, '0')}.mp4'`).join('\n') + '\n');
  await writeFile(join(output, 'output', 'subtitles.srt'), srtDocument(cues));
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner','-loglevel','error','-n','-f','concat','-safe','0','-i','list.ffconcat','-i','master.wav','-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a',`${encoding.audioKbps}k`,'-movflags','+faststart','output/highlight-vertical.mp4'], output);
  for (let i = 0; i < chosen.length; i++) {
    const cue = chosen[i].captions[0], at = map[i].startFrame / 30 + (cue.start + cue.end) / 2;
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner','-loglevel','error','-n','-ss',String(at),'-i','output/highlight-vertical.mp4','-frames:v','1',`review/${String(i).padStart(3, '0')}-${chosen[i].clip.id}.png`], output);
  }
  const probe = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v','error','-show_streams','-of','json','output/highlight-vertical.mp4'], output));
  const video = probe.streams.find((s: any) => s.codec_type === 'video'), audio = probe.streams.find((s: any) => s.codec_type === 'audio');
  assert(video.width === 1080 && video.height === 1920 && Number(video.nb_frames) === totalFrames, 'Video frame verification failed');
  assert(Math.abs(Number(video.duration) - Number(audio.duration)) <= 1 / 30 + .05, 'Audio/video duration mismatch');
  await writeFile(join(output, 'output', 'source-map.json'), JSON.stringify({ roomId: source.roomId, sourceSha256: hash(sourceBytes), selection, clips: map }, null, 2));
  await writeFile(join(output, 'output', 'verification.json'), JSON.stringify({
    roomId: source.roomId, width: 1080, height: 1920, fps: 30,
    bytes: (await stat(join(output, 'output', 'highlight-vertical.mp4'))).size, theme: selection.theme,
    excerpts: chosen.map(({ item, cut }) => ({ id: item.id, excerptNote: item.excerptNote, ...(cut ? { cut } : {}) })),
    frames: totalFrames, sampleCount: pcm.length / 2, encoder: encoder === 'gpu' ? 'h264_nvenc' : 'libx264',
    encoding, subjectiveListening: 'not-checked', transition: 'hard cuts within scenes; four-frame fades only at phase or chapter boundaries; audio unchanged',
    speechWaves: 'player speech only; selected PCM RMS and spectral bands drive a locally undulating continuous outer contour; silence suppressed',
    videoDuration: video.duration, audioDuration: audio.duration,
    videoSha256: hash(await readFile(join(output, 'output', 'highlight-vertical.mp4'))),
  }, null, 2));
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/vertical-highlight.ts')) {
  const opt = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
  const source = opt('source-project'), selection = opt('selection'), output = opt('output-dir'), encoder = opt('encoder');
  assert(source && selection && output && (encoder === 'cpu' || encoder === 'gpu'), 'Required: --source-project=PATH --selection=PATH --output-dir=NEW_PATH --encoder=cpu|gpu');
  await makeVertical(source, selection, output, encoder);
}
