import { readProjectEncodingEnvironment } from './production-settings';
import { renderWave } from './render-wave';
import { open } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile, readdir, rename } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { buildClips, clipVoiceProfile, loadScript, dataDir, type Clip, type Script, type VoiceCatalog } from './project';
import { assertPlayerRawAudio } from './player-audio-provenance';
import { assertFullNarration } from './editorial';
import { assertPlayerSources } from './integrity';
import { readPcm, wavHeader } from './audio';
import { inspectAudio } from './audio-inspection';
import { effectiveAudioAlignment } from './audio-alignment';
import { captionsFromWords, captionContent, sourceCaptionWords, srtDocument } from './timeline';
import { isPlayerSpeech, avatarWaveFrame, verticalScene, type StoryCard } from './vertical-scene';
import { encodingSettings, videoEncodingArgs, verifyEncodingRate, applyEncodingCli } from './encoding';
import { sceneTransition, sceneFadeFilters } from './transitions';
import { verticalVideoTitle } from './video-perspective';
import { videoAudioLanguage, videoLocale } from './video-locale';

const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
interface Item { id: string; quote: string; factReview: string; audioReview: string; excerptNote: string; audioSha256: string; wordStart?: number; wordEnd?: number; story?: StoryCard }
interface Selection { roomId: string; sourceSha256: string; reviewed: boolean; theme: string; clips: Item[]; review?: any }
function within(parent: string, child: string) { const r = relative(parent, child); return !r || (!r.startsWith('..') && !isAbsolute(r)); }
function ass(cues: { text: string; start: number; end: number }[]) {
  const time = (t: number) => { const n = Math.round(t * 100); return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, '0')}:${String(Math.floor(n / 100) % 60).padStart(2, '0')}.${String(n % 100).padStart(2, '0')}`; };
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Noto Sans SC,62,&H00FFFFFF,&H00FFFFFF,&H00101010,&H00000000,-1,0,0,0,100,100,0,0,1,4,1,8,90,90,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + cues.map(c => `Dialogue: 0,${time(c.start)},${time(c.end)},Default,,0,0,0,,{\\pos(540,1450)}${c.text.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\n/g, ' ')}`).join('\n') + '\n';
}
async function run(command: string, args: string[], cwd: string) {
  return await new Promise<string>((ok, fail) => {
    const child = spawn(command, args, { cwd, windowsHide: true }); let out = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { out += b; });
    child.on('error', fail); child.on('close', code => code === 0 ? ok(out) : fail(Error(`${command} exited ${code}: ${out.slice(-3000)}`)));
  });
}
export async function makeVertical(sourcePath: string, selectionPath: string | undefined, outputPath: string, encoder: 'cpu' | 'gpu', options?: { fullPlayer?: boolean; full?: boolean; sample?: boolean }) {
  const sourceDir = resolve(sourcePath), output = resolve(outputPath);
  assert(!within(sourceDir, output) && !within(output, sourceDir), 'Output must be separate from source project');
  assert(encoder === 'cpu' || encoder === 'gpu', 'Expected cpu or gpu encoder');
  const sourceBytes = await readFile(join(sourceDir, 'source.json'));
  const source = JSON.parse(sourceBytes.toString()) as Script;
  const script = JSON.parse(await readFile(join(sourceDir, 'script.json'), 'utf8')) as Script;
  const clips = JSON.parse(await readFile(join(sourceDir, 'clips.json'), 'utf8')) as Clip[];
  const voices = JSON.parse(await readFile(join(sourceDir, 'voices.json'), 'utf8')) as VoiceCatalog;
  const bound = JSON.parse(await readFile(join(sourceDir, 'avatar-theme.json'), 'utf8'));
  const full = !!(options?.full || options?.fullPlayer), sample = !!options?.sample;
  assert(!(full && sample), 'Full and sample modes are mutually exclusive');
  if (sample) assert(script.sample && !selectionPath, 'Sample mode requires a prepared sample project and no selection');
  if (full) { assert(!selectionPath, 'Full mode does not accept a selection'); assert(!script.sourceOnly && !script.sample, 'Full mode requires a complete script'); }
  if (options?.fullPlayer) assert(source.perspective === 'player', 'Full player mode requires a player project');
  const selection: Selection = (full || sample) ? { roomId: source.roomId, sourceSha256: hash(sourceBytes), reviewed: true, theme: bound.theme, clips: await Promise.all(clips.map(async clip => ({ id: clip.id, quote: clip.spokenText, factReview: 'authorized player source', audioReview: 'source audio', excerptNote: 'complete clip', audioSha256: hash(await readFile(join(sourceDir, 'audio', `${clip.id}.wav`))) }))) } : JSON.parse(await readFile(resolve(selectionPath!), 'utf8'));
  const finalVideo = sample ? 'output/sample-vertical.mp4' : full ? `output/full-${source.perspective}-vertical.mp4` : 'output/highlight-vertical.mp4';
  const partialVideo = 'output/video.partial.mp4';
  assert((source.perspective === 'god' || source.perspective === 'player') && script.perspective === source.perspective && source.status === 'ended', 'Only completed god or player projects are supported');
  assert(source.roomId === script.roomId && selection.roomId === source.roomId && selection.sourceSha256 === hash(sourceBytes), 'Wrong room or source hash');
  assert(selection.reviewed === true && Array.isArray(selection.clips) && selection.clips.length > 0, 'Selection has not been reviewed');
  if (!full && !sample && source.perspective === 'player') {
    const review = selection.review;
    assert(review && (review.approved === true || review.status === 'approved') && review.playerSeat === source.playerSeat && review.sourceSha256 === hash(sourceBytes) && review.visibleFactsOnly === true && review.clipsSha256 === hash(JSON.stringify(selection.clips)), 'Player selection requires source-bound review of visible facts only');
  }
  assert(selection.theme === bound.theme && ['campus','storybook','gufeng','fantasy','urban','future'].includes(selection.theme), 'Avatar theme mismatch');
  const expected = buildClips(script);
  if (sample) {
    const selected = JSON.parse(await readFile(join(sourceDir, 'sample-selection.json'), 'utf8'));
    assert.equal(selected.roomId, source.roomId, 'Sample selection belongs to another room');
    assert(Array.isArray(selected.sections) && selected.sections.length && Array.isArray(selected.clips), 'Invalid sample selection');
    const wanted = selected.sections.flatMap((section: any) => expected.filter(clip => section.sourceSeqs.includes(clip.sourceSeq) && (!section.parts?.[clip.sourceSeq] || section.parts[clip.sourceSeq].includes(clip.part))).map(clip => ({ ...clip, data: { ...clip.data, sampleSection: section.title } })));
    assert.equal(new Set(wanted.map((clip: Clip) => clip.id)).size, wanted.length, 'Duplicate sample selection');
    assert(wanted.every((clip: Clip, i: number) => !i || clip.sourceSeq >= wanted[i - 1].sourceSeq), 'Sample chronology changed');
    assert.deepEqual(selected.clips, wanted.map((clip: Clip) => ({ id: clip.id, sourceSeq: clip.sourceSeq, part: clip.part, type: clip.type, presentationOnly: !!clip.data.presentationOnly, text: clip.text })), 'Sample selection record differs from clips');
    assert.equal(clips.length, wanted.length, 'Incomplete sample clips');
    for (let i = 0; i < clips.length; i++) { const { audioFile: _a, ...a } = clips[i], { audioFile: _b, ...b } = wanted[i]; assert.deepEqual(a, b, 'Sample clip differs from selection'); }
  } else {
    assert.equal(clips.length, expected.length, 'Incomplete clips manifest');
    for (let i = 0; i < clips.length; i++) { const { audioFile: _a, ...a } = clips[i], { audioFile: _b, ...b } = expected[i]; assert.deepEqual(a, b, 'Clip manifest differs from script'); }
  }
  assert.deepEqual(script.events, source.events, 'Script changes source facts');
  if (full) {
    assert.deepEqual(script.cast, source.cast, 'Full video cast differs from authorized source');
    for (const entry of source.chapters.flatMap(chapter => chapter.entries).filter(entry => entry.seat !== undefined)) {
      const pieces = clips.filter(clip => clip.sourceSeq === entry.sourceSeq && clip.seat === entry.seat && !clip.data.presentationOnly);
      assert(pieces.length > 0 && pieces.map(clip => clip.text).join('').replace(/\s/gu, '') === entry.text.replace(/\s/gu, ''), `Missing or changed player speech: ${entry.sourceSeq}`);
    }
  }
  // Paths in generated manifests are tied to a particular checkout; validate the
  // semantic clip sequence and read audio only from the selected source project.
  assertPlayerSources(source, script, clips.map(clip => ({ ...clip, audioFile: expected.find(item => item.id === clip.id)?.audioFile ?? clip.audioFile })));
  if (full && source.perspective === 'god') {
    assert.deepEqual(source, await loadScript({ roomId: source.roomId, dataDir }), 'God source differs from current authorized export');
    await assertFullNarration(source, script, sourceDir);
  }
  if (sample && source.perspective === 'god') {
    const canonical = await loadScript({ roomId: source.roomId, dataDir });
    assert.deepEqual(source.events, canonical.events, 'Sample source events differ from authorized export');
    assert.deepEqual(source.cast, canonical.cast, 'Sample source cast differs from authorized export');
  }
  let masterClips = new Set<string>();
  if (source.perspective === 'player') {
    assert(source.playerSeat && Number.isInteger(source.playerSeat), 'Missing player seat');
    assert.deepEqual(source, await loadScript({ roomId: source.roomId, playerSeat: source.playerSeat, dataDir }), 'Player source differs from current authorized export');
    const used = new Set(selection.clips.map(item => item.id));
    assert([...used].every(id => clips.some(clip => clip.id === id)), 'Selection refers to an unknown source clip');
    masterClips = await assertPlayerRawAudio(source, voices, clips.filter(clip => used.has(clip.id)).map(clip => ({ ...clip, audioFile: join(sourceDir, 'audio', `${clip.id}.wav`) })), sourceDir);
  }
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
    if (!masterClips.has(clip.id)) {
      assert.equal(meta.voice, voice.voice, 'Audio voice differs from catalog'); assert.equal(meta.model, voices.model, 'Audio model differs from catalog');
    }
    assert.equal(meta.text, clip.spokenText, 'Audio metadata text differs'); assert.equal(meta.bytes, bytes.length, 'Audio metadata bytes differ');
    const { samples, sampleRate } = await readPcm(file); assert.equal(sampleRate, 24000, 'Expected 24 kHz PCM');
    const inspection = inspectAudio(samples, sampleRate); assert.equal(inspection.issues.length, 0, 'Audio waveform failed inspection');
    const choice = await effectiveAudioAlignment(file, meta, source.locale ?? 'zh-CN');
    const words = choice.meta.sentences.flatMap((sentence: any) => sentence.words);
    const audioLimitMs = samples.length / sampleRate * 1000;
    assert(words.every((word: any) => Number.isFinite(word.begin_time) && Number.isFinite(word.end_time) && word.begin_time >= 0 && word.end_time >= word.begin_time && word.end_time <= audioLimitMs + 1), `Word timing exceeds source audio: ${clip.id} max=${Math.max(...words.map((word: any) => word.end_time))} limit=${audioLimitMs}`);
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
  if (source.perspective === 'god' && !full && !sample) assert(totalFrames / 30 <= 120, 'Selection exceeds 120 seconds');
  const encoding = encodingSettings({ ...await readProjectEncodingEnvironment(sourceDir), VIDEO_ENCODER: encoder === 'gpu' ? 'h264_nvenc' : 'libx264', VIDEO_REQUIRE_GPU: encoder === 'gpu' ? '1' : '0' });
  const scenes = chosen.map(c => ({ ...c.clip, frames: c.frames }));
  // A bound identity allows only the same inputs and settings to reuse this directory.
  const identity = hash(JSON.stringify({ version: 'vertical-view-v5', source: hash(sourceBytes), selection, encoding, locale: process.env.VIDEO_LOCALE, clips: chosen.map(c => ({ id: c.clip.id, frames: c.frames, alignment: c.alignment, captions: c.captions })) }));
  if (!full && !sample) { await mkdir(output, { recursive: false }); }
  else {
    await mkdir(output, { recursive: true });
    try { const old = JSON.parse(await readFile(join(output, 'identity.json'), 'utf8')); assert.equal(old.identity, identity, 'Output belongs to different inputs or settings'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; assert.equal((await readdir(output)).length, 0, 'Existing output has no matching identity'); await writeFile(join(output, 'identity.json'), JSON.stringify({ identity }), { flag: 'wx' }); }
  }
  await mkdir(join(output, 'output'), { recursive: true }); await mkdir(join(output, 'review'), { recursive: true });
  await writeFile(join(output, 'encoding-settings.json'), JSON.stringify(encoding, null, 2));
  const starts: number[] = []; let frameCursor = 0;
  for (const c of chosen) { starts.push(frameCursor); frameCursor += c.frames; }
  const cueParts: {text: string; start: number; end: number}[][] = Array(chosen.length), map: any[] = Array(chosen.length);
  const renderOne = async (i: number) => {
    const c = chosen[i], start = starts[i], stem = String(i).padStart(3, '0');
    const image = await verticalScene(c.clip, selection.theme, script, c.item.story); await writeFile(join(output, `${stem}.png`), image);
    await writeFile(join(output, `${stem}.ass`), ass(c.captions));
    cueParts[i] = c.captions.map(x => ({ ...x, start: x.start + start / 30, end: x.end + start / 30 }));
    map[i] = { ...c.item, startFrame: start, frames: c.frames, sampleCount: c.pcm.length, alignment: c.alignment, ...(c.cut ? { cut: c.cut } : {}) };
    const segment = join(output, `${stem}.mp4`), marker = `${segment}.json`;
    const segmentKey = hash(Buffer.concat([image, Buffer.from(ass(c.captions)), Buffer.from(identity), Buffer.from(JSON.stringify({ frames: c.frames, transition: sceneTransition(scenes[i], scenes[i - 1], scenes[i + 1]) }))]));
    let cached = false;
    if (full || sample) try { const saved = JSON.parse(await readFile(marker, 'utf8')); cached = saved.key === segmentKey && saved.sha256 === hash(await readFile(segment)); } catch { /* Missing or incomplete segment. */ }
    if (cached) { console.log(JSON.stringify({ rendered: i + 1, total: chosen.length, clip: c.clip.id, cached })); return; }
    const speaking = isPlayerSpeech(c.clip);
    const pipeWave = speaking && (full || sample);
    if (speaking && !pipeWave) {
      await mkdir(join(output, 'rings', stem), { recursive: true });
      for (let frame = 0; frame < c.frames; frame++) await writeFile(join(output, 'rings', stem, `${String(frame).padStart(6, '0')}.png`), avatarWaveFrame(c.pcm, frame));
    }
    const codec = videoEncodingArgs(encoding), fade = [`ass=${stem}.ass`, ...sceneFadeFilters(sceneTransition(scenes[i], scenes[i - 1], scenes[i + 1]), c.frames)].join(','), visual = speaking
      ? [...(pipeWave ? ['-f','image2pipe','-framerate','30','-vcodec','png','-i','pipe:0'] : ['-framerate','30','-i',`rings/${stem}/%06d.png`]),'-filter_complex_threads','1','-filter_complex',`[0:v][1:v]overlay=130:370:shortest=1,${fade}[v]`,'-map','[v]']
      : ['-vf', fade];
    const args = ['-hide_banner','-loglevel','error','-y','-loop','1','-framerate','30','-i',`${stem}.png`,...visual,'-frames:v',String(c.frames),...codec,'-r','30',`${stem}.mp4`];
    if (pipeWave) await renderWave(args,output,c.pcm,c.frames);
    else await run(process.env.FFMPEG_PATH || 'ffmpeg',args,output);
    if (full || sample) await writeFile(marker, JSON.stringify({ key: segmentKey, sha256: hash(await readFile(segment)) }));
    console.log(JSON.stringify({ rendered: i + 1, total: chosen.length, clip: c.clip.id }));
  };
  let cursor = 0; const jobs = Math.max(1, Math.min(2, Number(process.env.VIDEO_JOBS) || 2));
  const worker = async () => { while (true) { const i = cursor++; if (i >= chosen.length) return; await renderOne(i); } };
  await Promise.all(Array.from({ length: jobs }, () => worker()));
  const cues = cueParts.flat(), samples = totalFrames * 800, mix = await open(join(output,'master.wav'),'w');
  try {
    await mix.writeFile(wavHeader(samples,24000));
    for (const clip of chosen) {
      const padded = Buffer.alloc(clip.frames * 1600);
      Buffer.from(clip.pcm.buffer,clip.pcm.byteOffset,clip.pcm.byteLength).copy(padded);
      await mix.writeFile(padded);
    }
  } finally { await mix.close(); }
  await writeFile(join(output, 'list.ffconcat'), 'ffconcat version 1.0\n' + chosen.map((_, i) => `file '${String(i).padStart(3, '0')}.mp4'`).join('\n') + '\n');
  await writeFile(join(output, 'output', 'subtitles.srt'), srtDocument(cues));
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i','list.ffconcat','-i','master.wav','-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a',`${encoding.audioKbps}k`,'-metadata',`title=${verticalVideoTitle(script)}`,'-metadata:s:a:0',`language=${videoAudioLanguage(script.locale)}`,'-movflags','+faststart',partialVideo], output);
  const bitrate = await verifyEncodingRate(join(output, partialVideo), encoding);
  await rename(join(output, partialVideo), join(output, finalVideo));
  for (let i = 0; i < chosen.length; i++) {
    const cue = chosen[i].captions[0], at = map[i].startFrame / 30 + (cue.start + cue.end) / 2;
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner','-loglevel','error','-y','-ss',String(at),'-i',finalVideo,'-frames:v','1',`review/${String(i).padStart(3, '0')}-${chosen[i].clip.id}.png`], output);
  }
  const probe = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v','error','-show_streams','-of','json',finalVideo], output));
  const video = probe.streams.find((s: any) => s.codec_type === 'video'), audio = probe.streams.find((s: any) => s.codec_type === 'audio');
  assert(video.width === 1080 && video.height === 1920 && Number(video.nb_frames) === totalFrames, 'Video frame verification failed');
  assert(Math.abs(Number(video.duration) - Number(audio.duration)) <= 1 / 30 + .05, 'Audio/video duration mismatch');
  await writeFile(join(output, 'output', 'source-map.json'), JSON.stringify({ roomId: source.roomId, sourceSha256: hash(sourceBytes), selection, clips: map }, null, 2));
  await writeFile(join(output, 'output', 'verification.json'), JSON.stringify({
    roomId: source.roomId, mode: sample ? 'sample' : full ? `full-${source.perspective}` : 'highlight', bitrate, width: 1080, height: 1920, fps: 30,
    bytes: (await stat(join(output, finalVideo))).size, theme: selection.theme,
    excerpts: chosen.map(({ item, cut }) => ({ id: item.id, excerptNote: item.excerptNote, ...(cut ? { cut } : {}) })),
    frames: totalFrames, sampleCount: samples, encoder: encoder === 'gpu' ? 'h264_nvenc' : 'libx264',
    encoding, subjectiveListening: 'not-checked', transition: 'hard cuts within scenes; four-frame fades only at phase or chapter boundaries; audio unchanged',
    speechWaves: 'player speech only; selected PCM RMS and spectral bands drive a locally undulating continuous outer contour; silence suppressed',
    videoDuration: video.duration, audioDuration: audio.duration,
    videoSha256: hash(await readFile(join(output, finalVideo))),
  }, null, 2));
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/vertical-highlight.ts')) {
  const opt = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
  applyEncodingCli(process.argv.slice(2));
  const source = opt('source-project'), selection = opt('selection'), output = opt('output-dir'), encoder = opt('encoder');
  const locale = opt('video-locale');
  if (locale) { videoLocale(undefined, locale); process.env.VIDEO_LOCALE = locale; }
  const fullPlayer = process.argv.includes('--full-player'), full = process.argv.includes('--full'), sample = process.argv.includes('--sample');
  assert(Number(full) + Number(fullPlayer) + Number(sample) <= 1, 'Choose one mode');
  assert(source && (fullPlayer || full || sample ? !selection : !!selection) && output && (encoder === 'cpu' || encoder === 'gpu'), 'Required: --source-project=PATH (--selection=PATH | --full | --full-player | --sample) --output-dir=NEW_PATH --encoder=cpu|gpu');
  await makeVertical(source, selection, output, encoder, { fullPlayer, full, sample });
}
