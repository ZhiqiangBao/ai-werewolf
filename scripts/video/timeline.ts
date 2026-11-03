import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { projectDir, FPS, SAMPLE_RATE, spokenText, type Clip, type TimedClip, type VoiceCatalog } from './project';
import type { AudioMeta } from './qwen';
import { readPcm, wavHeader } from './audio';
import { subtitleLayout } from './geometry';
import { inspectAudio } from './audio-inspection';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { assertAuthorizedProject } from './integrity';
import { assertPlayerRawAudio } from './player-audio-provenance';
import { assertPreviousAlignment, effectiveAudioAlignment, type AlignmentSummary } from './audio-alignment';

export const captionContent = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, '');
const symbolReadings: Record<string, string> = { '+': '加', '≥': '大于等于', '≤': '小于等于', '>': '大于', '<': '小于', '=': '等于' };
function spokenPositions(text: string) {
  return [...text].flatMap((char, index) => [...(symbolReadings[char] ?? captionContent(char))].map(() => index));
}

export interface SourceSpan { start: number; end: number; numeric: boolean }
const englishSmall = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const englishTens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const japaneseDigits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const englishSymbols: Record<string, string> = { '+': 'plus', '≥': 'greaterthanorequalto', '≤': 'lessthanorequalto', '>': 'greaterthan', '<': 'lessthan', '=': 'equals', '%': 'percent' };
function numberReading(raw: string, language: 'en' | 'ja'): string | undefined {
  if (!/^(?:0|[1-9]\d?)(?:\.\d{1,3})?$/.test(raw)) return undefined;
  const [whole, fraction] = raw.split('.'), n = Number(whole);
  if (language === 'ja' && fraction !== undefined) return undefined;
  const integer = language === 'en'
    ? n < 20 ? englishSmall[n] : englishTens[Math.floor(n / 10)] + (n % 10 ? englishSmall[n % 10] : '')
    : n < 10 ? japaneseDigits[n] : (n >= 20 ? japaneseDigits[Math.floor(n / 10)] : '') + '十' + (n % 10 ? japaneseDigits[n % 10] : '');
  return integer + (fraction === undefined ? '' : 'point' + [...fraction].map((digit) => englishSmall[Number(digit)]).join(''));
}

/** Canonical letters retain the exact source span; a number remains one indivisible span. */
function normalizedSpans(text: string, language: 'en' | 'ja') {
  const chars = [...text], normalized: string[] = [], spans: SourceSpan[] = [];
  for (let i = 0; i < chars.length;) {
    if ((chars[i] === '-' || chars[i] === '−') && /^[0-9]$/.test(chars[i + 1] ?? '')) {
      for (const char of language === 'en' ? 'minus' : '負') { normalized.push(char); spans.push({ start: i, end: i + 1, numeric: true }); }
      i++; continue;
    }
    const numeric = /^[0-9]+(?:\.[0-9]+)?/.exec(chars.slice(i).join(''))?.[0];
    const reading = numeric && numberReading(numeric, language);
    if (numeric) {
      for (const char of reading ?? numeric) { normalized.push(char); spans.push({ start: i, end: i + numeric.length, numeric: true }); }
      i += numeric.length; continue;
    }
    if (Object.hasOwn(englishSymbols, chars[i])) {
      const symbol = language === 'en' ? englishSymbols[chars[i]] : chars[i];
      for (const char of symbol) { normalized.push(char); spans.push({ start: i, end: i + 1, numeric: false }); }
      i++; continue;
    }
    const value = captionContent(chars[i]);
    for (const char of value.toLocaleLowerCase('en')) { normalized.push(char); spans.push({ start: i, end: i + 1, numeric: false }); }
    i++;
  }
  return { normalized: normalized.join(''), spans };
}

/** Source-codepoint ranges for strict supported-language alignment. */
export function captionSpans(text: string, locale: string) {
  const language = new Intl.Locale(locale).language;
  if (language !== 'en' && language !== 'ja') throw Error('External transcript alignment supports en and ja only');
  return normalizedSpans(text, language);
}

/** A long near-identical contiguous run is suspicious and needs real alignment. */
export function assertNonUniformWordTimes(words: { begin_time: number; end_time: number }[]) {
  let run: number[] = [], previousEnd: number | undefined;
  for (const word of words) {
    const duration = word.end_time - word.begin_time;
    if (!Number.isFinite(duration) || duration <= 0 || (previousEnd !== undefined && Math.abs(word.begin_time - previousEnd) > 2) || (run.length && (Math.max(...run, duration) - Math.min(...run, duration) > 2))) run = [];
    if (Number.isFinite(duration) && duration > 0) run.push(duration);
    previousEnd = word.end_time;
    if (run.length >= 20) throw Error('Suspicious uniformly spaced word timestamps; realignment is required');
  }
}

/** Exact normalized content for comparing an independently obtained transcript, not timestamps. */
export function normalizedCaptionText(text: string, locale: string) {
  const language = new Intl.Locale(locale).language;
  if (language === 'en' || language === 'ja') return normalizedSpans(text, language).normalized;
  if (language === 'zh') return [...spokenText(text, locale)].map((char) => symbolReadings[char] ?? captionContent(char)).join('').toLocaleLowerCase('en');
  return captionContent(text).toLocaleLowerCase('en');
}

function strictCaptionWords(meta: AudioMeta, language: 'en' | 'ja') {
  const timedWords = meta.sentences.flatMap((sentence) => sentence.words);
  if (!timedWords.length) throw Error('Missing provider word timestamps; alignment is required');
  const source = [...meta.text], expected = normalizedSpans(meta.text, language);
  const normalizedWords = timedWords.map((word) => normalizedSpans(word.text, language).normalized);
  assert(normalizedWords.join('') === expected.normalized, 'Timestamp labels differ from the normalized script; realignment is required');
  const words: typeof timedWords = []; let cursor = 0, offset = 0;
  let first: typeof timedWords[number] | undefined, previous: typeof timedWords[number] | undefined;
  for (let i = 0; i < timedWords.length; i++) {
    const word = timedWords[i], count = [...normalizedWords[i]].length;
    if (!count) continue;
    assert(Number.isFinite(word.begin_time) && Number.isFinite(word.end_time) && word.begin_time >= 0 && word.end_time > word.begin_time, 'Invalid provider word timestamps; realignment is required');
    if (previous) assert(word.begin_time >= previous.begin_time && word.end_time >= previous.end_time, 'Out-of-order provider timestamps; realignment is required');
    if (first && previous && expected.spans[cursor - 1]?.numeric && word.begin_time - previous.end_time > 1000) throw Error('Unreliable timestamp gap inside a number; realignment is required');
    first ??= word; cursor += count; previous = word;
    const lastSpan = expected.spans[cursor - 1], nextSpan = expected.spans[cursor];
    if (nextSpan && lastSpan.start === nextSpan.start && lastSpan.end === nextSpan.end) continue;
    const end = lastSpan.end;
    words.push({ ...word, begin_time: first.begin_time, begin_index: first.begin_index, text: source.slice(offset, end).join('') });
    offset = end; first = undefined;
  }
  assert(words.length, 'Missing spoken-word timestamps; alignment is required');
  words.at(-1)!.text += source.slice(offset).join('');
  assert.equal(words.map((word) => word.text).join(''), meta.text);
  return words;
}

/** Provider labels locate sounds; the submitted script remains the spelling authority. */
export function sourceCaptionWords(meta: AudioMeta, locale = 'zh-CN') {
  assertNonUniformWordTimes(meta.sentences.flatMap((sentence) => sentence.words));
  const language = new Intl.Locale(locale).language;
  if (language === 'en' || language === 'ja') return strictCaptionWords(meta, language);
  const timedWords = meta.sentences.flatMap((s) => s.words);
  if (!timedWords.length) throw Error('Missing provider word timestamps; alignment is required');
  const source = [...meta.text], positions = spokenPositions(meta.text);
  const counts = timedWords.map((w) => spokenPositions(w.text).length);
  assert.equal(counts.reduce((n, count) => n + count, 0), positions.length,
    'Timestamp labels omit or add spoken characters; realignment is required');
  const words: typeof timedWords = []; let cursor = 0, offset = 0;
  let first: typeof timedWords[number] | undefined;
  timedWords.forEach((word, i) => {
    if (!counts[i]) return;
    first ??= word;
    cursor += counts[i];
    // A symbol such as ≥ spans several spoken words. Merge their real timestamp
    // boundaries instead of assigning invented timings to pieces of the symbol.
    if (cursor < positions.length && positions[cursor - 1] === positions[cursor]) return;
    const end = positions[cursor - 1] + 1;
    words.push({ ...word, begin_time: first.begin_time, begin_index: first.begin_index, text: source.slice(offset, end).join('') });
    offset = end; first = undefined;
  });
  assert(words.length, 'Missing spoken-word timestamps; alignment is required');
  words.at(-1)!.text += source.slice(offset).join('');
  assert.equal(words.map((w) => w.text).join(''), meta.text);
  return words;
}

export function captionsFromWords(meta: AudioMeta, duration: number, locale = 'zh-CN') {
  const words = sourceCaptionWords(meta, locale);
  const captions: { text: string; start: number; end: number }[] = [];
  let text = '', start = 0, end = 0;
  const flush = () => { if (text.trim()) captions.push({ text, start, end: Math.min(duration, end + .12) }); text = ''; };
  for (const w of words) {
    const leading = w.text.match(/^[，。！？；、,.!?;：:]+/)?.[0] ?? '';
    if (text && (text.length >= 23 || (leading && text.length >= 9) || w.begin_time / 1000 - end > .55)) {
      text += leading; flush();
    }
    const part = !text && leading ? w.text.slice(leading.length) : w.text;
    if (!part) continue;
    if (!text) start = Math.max(0, w.begin_time / 1000 - .06);
    text += part; end = w.end_time / 1000;
  }
  flush();
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i]; if (i + 1 < captions.length) c.end = Math.min(c.end, captions[i + 1].start);
    assert(c.end > c.start && c.end <= duration + .001, 'Invalid timestamped caption');
  }
  return captions;
}
function assTime(t: number) {
  const n = Math.max(0, Math.round(t * 100)), seconds = Math.floor(n / 100);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(n % 100).padStart(2, '0')}`;
}
const escapeAss = (s: string) => s.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\n/g, '\\N');
export function assDocument(cues: { text: string; start: number; end: number; phase?: string }[], phase = 'night') {
  const { caption } = subtitleLayout, right = 1920 - caption.x - caption.width;
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Night,Microsoft YaHei,36,&H00FFFFFF,&H000000FF,&H00351E10,&H90000000,-1,0,0,0,100,100,0,0,1,2,1,5,${caption.x},${right},0,1\nStyle: Day,Microsoft YaHei,36,&H00363E26,&H000000FF,&H00E7F5FB,&H00E7F5FB,-1,0,0,0,100,100,0,0,1,1,0,5,${caption.x},${right},0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},${(c.phase ?? phase) === 'night' ? 'Night' : 'Day'},,0,0,0,,{\\an5\\pos(${caption.centerX},${caption.centerY})}${escapeAss(c.text)}`).join('\n') + '\n';
}
export function srtDocument(cues: { text: string; start: number; end: number }[]) {
  const time = (t: number) => { const ms = Math.round(t * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  return cues.map((c, i) => `${i + 1}\n${time(c.start)} --> ${time(c.end)}\n${c.text}\n`).join('\n');
}

export async function buildTimeline() {
  const clips = JSON.parse(await readFile(`${projectDir}/clips.json`, 'utf8')) as Clip[];
  const { source } = await assertAuthorizedProject(clips);
  const previous = existsSync(`${projectDir}/timeline.json`) ? JSON.parse(await readFile(`${projectDir}/timeline.json`, 'utf8')) as { clips: TimedClip[] } : undefined;
  const auditFile = `${projectDir}/output/audio-audit.json`;
  const previousAudit = existsSync(auditFile) ? JSON.parse(await readFile(auditFile, 'utf8')) as { clips: { id: string; alignment?: AlignmentSummary }[] } : undefined;
  if (source.perspective === 'player') await assertPlayerRawAudio(source, JSON.parse(await readFile(`${projectDir}/voices.json`, 'utf8')) as VoiceCatalog, clips);
  // Validate every source before writing any normalized audio, captions or timeline.
  const selected = new Map<string, Awaited<ReturnType<typeof effectiveAudioAlignment>>>();
  for (const clip of clips) {
    const meta = JSON.parse(await readFile(`${clip.audioFile}.json`, 'utf8')) as AudioMeta;
    assert.equal(meta.text, clip.spokenText, `Stale audio: ${clip.id}`);
    const pcm = await readPcm(clip.audioFile); assert.equal(pcm.sampleRate, SAMPLE_RATE);
    const choice = await effectiveAudioAlignment(clip.audioFile, meta, source.locale ?? 'zh-CN');
    assertPreviousAlignment(choice.summary, previous?.clips.find((item) => item.id === clip.id)?.captionAlignment);
    assertPreviousAlignment(choice.summary, previousAudit?.clips.find((item) => item.id === clip.id)?.alignment);
    const cues = captionsFromWords(choice.meta, pcm.samples.length / pcm.sampleRate, source.locale ?? 'zh-CN');
    assert.equal(captionContent(cues.map((cue) => cue.text).join('')), captionContent(clip.spokenText), `Caption text changed in ${clip.id}`);
    selected.set(clip.id, choice);
  }
  await mkdir(`${projectDir}/subtitles`, { recursive: true });
  await mkdir(`${projectDir}/audio-normalized`, { recursive: true });
  const timed: TimedClip[] = []; let startFrame = 0;
  const pcmPaths: { bytes: Buffer; frames: number }[] = [];
  const quality: { id: string; duration: number; rms: number; peak: number; gain: number; words: number }[] = [];
  const captionAudit: { id: string; submitted: string; providerLabels: string; correctedCaption: string }[] = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i], audioMeta = JSON.parse(await readFile(clip.audioFile + '.json', 'utf8')) as AudioMeta;
    assert.equal(audioMeta.text, clip.spokenText, `Stale audio: ${clip.id}`);
    const { samples, sampleRate } = await readPcm(clip.audioFile);
    assert.equal(sampleRate, SAMPLE_RATE);
    const inspection = inspectAudio(samples, sampleRate);
    assert.equal(inspection.issues.length, 0, `Audio waveform defects in ${clip.id}; run video:audit-audio and video:repair-audio`);
    const { rms, peak } = inspection; assert(rms > .002 && peak > .02, `Silent clip: ${clip.id}`);
    const gain = Math.min(1.8, Math.max(.65, .10 / rms), .94 / peak);
    const audioDuration = samples.length / sampleRate;
    const next = clips[i + 1], padding = !next || next.chapter !== clip.chapter ? .8 : next.sourceSeq !== clip.sourceSeq ? .36 : .14;
    const frames = Math.ceil((audioDuration + padding) * FPS), frameSamples = frames * SAMPLE_RATE / FPS;
    assert(Number.isInteger(frameSamples));
    const bytes = Buffer.alloc(frameSamples * 2), envelope: number[] = [];
    for (let j = 0; j < samples.length; j++) bytes.writeInt16LE(Math.round(samples[j] * gain), j * 2);
    const normalized = Buffer.concat([wavHeader(frameSamples, SAMPLE_RATE), bytes]);
    await writeFile(`${projectDir}/audio-normalized/${clip.id}.wav`, normalized);
    for (let frame = 0; frame < frames; frame++) {
      let energy = 0;
      for (let j = frame * 800; j < Math.min(samples.length, (frame + 1) * 800); j++) energy += (samples[j] * gain / 32768) ** 2;
      envelope.push(Math.sqrt(energy / 800));
    }
    const choice = selected.get(clip.id)!;
    const captions = captionsFromWords(choice.meta, audioDuration, source.locale ?? 'zh-CN');
    assert.equal(captionContent(captions.map((c) => c.text).join('')), captionContent(clip.spokenText), `Caption text changed in ${clip.id}`);
    const providerLabels = audioMeta.sentences.flatMap((s) => s.words.map((w) => w.text)).join('');
    if (captionContent(providerLabels) !== captionContent(clip.spokenText)) captionAudit.push({ id: clip.id, submitted: clip.spokenText, providerLabels, correctedCaption: captions.map((c) => c.text).join('') });
    const out = { ...clip, startFrame, frames, audioDuration, audioMeta, captions, envelope, ...(choice.summary ? { captionAlignment: choice.summary } : {}),
      normalizedAudioSha256: createHash('sha256').update(normalized).digest('hex') };
    timed.push(out); startFrame += frames; pcmPaths.push({ bytes, frames });
    quality.push({ id: clip.id, duration: audioDuration, rms, peak, gain, words: audioMeta.sentences.reduce((s, v) => s + v.words.length, 0) });
    await writeFile(`${projectDir}/subtitles/${clip.id}.ass`, assDocument(captions, clip.phase));
  }
  const master = await open(`${projectDir}/master.wav`, 'w');
  await master.write(wavHeader(startFrame * SAMPLE_RATE / FPS, SAMPLE_RATE));
  for (const item of pcmPaths) await master.write(item.bytes);
  await master.close();
  const absoluteCues = timed.flatMap((c) => c.captions.map((cue) => ({ ...cue, phase: c.phase, start: cue.start + c.startFrame / FPS, end: cue.end + c.startFrame / FPS })));
  await writeFile(`${projectDir}/subtitles/captions.ass`, assDocument(absoluteCues));
  await writeFile(`${projectDir}/subtitles/captions.srt`, srtDocument(absoluteCues));
  await writeFile(`${projectDir}/audio-quality.json`, JSON.stringify(quality, null, 2));
  await writeFile(`${projectDir}/caption-audit.json`, JSON.stringify({ textSource: 'submitted-script', timeSource: 'per-clip provider or independent transcript word times',
    alignments: timed.map((clip) => ({ id: clip.id, ...(clip.captionAlignment ?? { method: 'provider' }) })), labelDifferences: captionAudit }, null, 2));
  await writeFile(`${projectDir}/timeline.json`, JSON.stringify({ format: 'werewolf-audio-timeline', version: 1, fps: FPS, sampleRate: SAMPLE_RATE, frames: startFrame, duration: startFrame / FPS, clips: timed }, null, 2));
  console.log(JSON.stringify({ clips: timed.length, durationSeconds: startFrame / FPS, minutes: Math.round(startFrame / FPS / 60 * 10) / 10, captions: absoluteCues.length, timestampSource: [...new Set(timed.map((c) => c.captionAlignment?.engine ?? c.audioMeta.alignment?.engine ?? c.audioMeta.provider ?? 'Qwen word timestamps'))].join(', '), allAudioMeasured: true }));
  return timed;
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/timeline.ts')) await buildTimeline();
