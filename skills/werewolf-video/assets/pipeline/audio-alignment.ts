import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AudioMeta, Word } from './qwen';
import { reviewAudioContent, type TranscriptAlias } from './audio-content-review';
import { assertNonUniformWordTimes, captionSpans, captionsFromWords, normalizedCaptionText } from './timeline';
import { readPcm } from './audio';
import type { TimedClip } from './project';

interface AsrWord extends Word { punctuation?: string }
export interface AudioAlignmentInput { audio: Buffer; metadata: Buffer; asrResponse: string; locale: string; aliases?: TranscriptAlias[] }
export interface ExternalAlignment {
  format: 'werewolf-external-transcript-alignment'; version: 1; method: 'external-transcript'; engine: string;
  audioSha256: string; metadataSha256: string; sourceSha256: string; responseSha256: string; transcriptSha256: string;
  aliasesSha256: string; wordTimesSha256: string; mappedWordsSha256: string; locale: string;
  aliases: TranscriptAlias[]; asrResponse: string; words: Word[];
}
export interface AlignmentSummary { method: 'external-transcript'; engine: string; sidecarSha256: string; audioSha256: string; metadataSha256: string;
  sourceSha256: string; responseSha256: string; transcriptSha256: string; aliasesSha256: string; wordTimesSha256: string; mappedWordsSha256: string }
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

/** A previously selected external alignment must never silently fall back or change. */
export function assertPreviousAlignment(current: AlignmentSummary | undefined, previous: AlignmentSummary | undefined) {
  if (previous) assert.deepEqual(current, previous, 'Previously selected external alignment is missing or changed');
}

function wavDurationMs(audio: Buffer) {
  assert(audio.length >= 44 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE', 'Expected a WAV file');
  let rate = 0, channels = 0, bits = 0, format = 0, dataSize: number | undefined;
  for (let at = 12; at + 8 <= audio.length;) {
    const name = audio.toString('ascii', at, at + 4), size = audio.readUInt32LE(at + 4), start = at + 8;
    // Qwen streaming WAV uses a large unknown-length RIFF/data sentinel; actual PCM ends at EOF.
    if (name === 'data' && start + size > audio.length && size >= 0x7fff0000 && audio.readUInt32LE(4) >= 0x7fff0000) {
      assert(dataSize === undefined, 'Duplicate WAV data chunk'); dataSize = audio.length - start; break;
    }
    assert(start + size <= audio.length, 'Truncated WAV chunk');
    if (name === 'fmt ') { assert(size >= 16, 'Invalid WAV format'); format = audio.readUInt16LE(start); channels = audio.readUInt16LE(start + 2); rate = audio.readUInt32LE(start + 4); bits = audio.readUInt16LE(start + 14); }
    if (name === 'data') { assert(dataSize === undefined, 'Duplicate WAV data chunk'); dataSize = size; }
    at = start + size + size % 2;
  }
  assert(format === 1 && channels === 1 && bits === 16 && rate > 0 && dataSize !== undefined && dataSize % 2 === 0, 'Expected mono PCM16 WAV');
  return dataSize / 2 / rate * 1000;
}

/** Import the actual, independently requested Qwen ASR result without altering its audio or TTS metadata. */
export function createAudioAlignment(input: AudioAlignmentInput): ExternalAlignment {
  const meta = JSON.parse(input.metadata.toString('utf8')) as AudioMeta;
  const response = JSON.parse(input.asrResponse) as any;
  const hash = digest(input.audio);
  assert(response.rawAudioSha256 === hash && response.sourcePromptProvided === false, 'ASR response is not bound to the original audio or used a source prompt');
  assert(response.truncated !== true && response.result?.output?.finish_reason !== 'length', 'Truncated ASR response cannot provide alignment');
  assert(typeof response.model === 'string' && response.model.trim(), 'ASR engine is missing');
  const sentence = response.result?.output?.sentence;
  assert(sentence && typeof sentence.text === 'string' && Array.isArray(sentence.words) && sentence.words.length > 0, 'Missing ASR transcript or word timestamps');
  assert(typeof meta.text === 'string' && meta.bytes === input.audio.length, 'TTS metadata does not match the audio');
  const aliases = input.aliases ?? [];
  const review = reviewAudioContent({ audio: input.audio, sourceText: meta.text, transcript: sentence.text, locale: input.locale, aliases });
  assert(review.matches, 'Independent ASR transcript differs from the source');
  const duration = wavDurationMs(input.audio), words = sentence.words as AsrWord[];
  let previous: AsrWord | undefined;
  for (const word of words) {
    assert(typeof word.text === 'string' && word.text.length > 0 && (word.punctuation === undefined || typeof word.punctuation === 'string'), 'Invalid ASR word text');
    assert(Number.isFinite(word.begin_time) && Number.isFinite(word.end_time) && word.begin_time >= 0 && word.end_time > word.begin_time && word.end_time <= duration + 1, 'ASR word outside audio duration');
    if (previous) assert(word.begin_time >= previous.begin_time && word.end_time >= previous.end_time, 'ASR words are out of order');
    previous = word;
  }
  assertNonUniformWordTimes(words);
  const rawChars: string[] = [], rawWord: number[] = [];
  words.forEach((word, index) => { for (const char of [...word.text, ...(word.punctuation ?? '')]) { rawChars.push(char); rawWord.push(index); } });
  const raw = captionSpans(rawChars.join(''), input.locale);
  assert(raw.normalized === normalizedCaptionText(sentence.text, input.locale), 'ASR words differ from their independent transcript');
  const rawUnits = raw.spans.map((span) => ({ first: Math.min(...rawWord.slice(span.start, span.end)), last: Math.max(...rawWord.slice(span.start, span.end)) }));
  const replacements = aliases.map((alias) => ({ source: normalizedCaptionText(alias.source, input.locale), transcript: normalizedCaptionText(alias.transcript, input.locale) })).sort((a, b) => b.transcript.length - a.transcript.length);
  assert(replacements.every((a) => a.source && a.transcript), 'Empty normalized alias');
  const normalizedChars = [...raw.normalized], mapped: string[] = [], units: { first: number; last: number }[] = [];
  for (let i = 0; i < normalizedChars.length;) {
    const alias = replacements.find((item) => normalizedChars.slice(i, i + [...item.transcript].length).join('') === item.transcript);
    if (!alias) { mapped.push(normalizedChars[i]); units.push(rawUnits[i]); i++; continue; }
    const count = [...alias.transcript].length, covered = rawUnits.slice(i, i + count);
    const span = { first: Math.min(...covered.map((item) => item.first)), last: Math.max(...covered.map((item) => item.last)) };
    for (const char of alias.source) { mapped.push(char); units.push(span); }
    i += count;
  }
  const source = captionSpans(meta.text, input.locale), sourceChars = [...meta.text];
  assert(mapped.join('') === source.normalized && units.length === source.spans.length, 'ASR word alignment differs from the source');
  const used = new Set(rawUnits.flatMap((span) => Array.from({ length: span.last - span.first + 1 }, (_, i) => span.first + i)));
  const hasContent = words.map((word) => Boolean(normalizedCaptionText(word.text + (word.punctuation ?? ''), input.locale)));
  assert(words.every((_, index) => used.has(index) || !hasContent[index]), 'An ASR word has no alignable content');
  const result: Word[] = []; let at = 0, sourceOffset = 0, lastWord = -1;
  while (at < units.length) {
    let end = at + 1, first = units[at].first, last = units[at].last, sourceEnd = source.spans[at].end;
    while (end < units.length && (units[end].first <= last || source.spans[end].start < sourceEnd)) {
      last = Math.max(last, units[end].last); sourceEnd = Math.max(sourceEnd, source.spans[end].end); end++;
    }
    assert(first > lastWord && last >= first && words.slice(lastWord + 1, first).every((_, i) => !hasContent[lastWord + 1 + i]), 'ASR word boundaries overlap or skip a word');
    let previousContent = first;
    for (let i = first + 1; i <= last; i++) {
      if (hasContent[i]) {
        assert(words[i].begin_time - words[previousContent].end_time <= 1000, 'Unreliable timestamp gap inside an aligned source span');
        previousContent = i;
      }
    }
    result.push({ text: sourceChars.slice(sourceOffset, sourceEnd).join(''), begin_time: words[first].begin_time, end_time: words[last].end_time });
    lastWord = last; sourceOffset = sourceEnd; at = end;
  }
  assert(result.length && words.slice(lastWord + 1).every((_, i) => !hasContent[lastWord + 1 + i]), 'Not all ASR words were consumed');
  result.at(-1)!.text += sourceChars.slice(sourceOffset).join('');
  assert(result.map((word) => word.text).join('') === meta.text, 'Alignment changed the original text');
  return { format: 'werewolf-external-transcript-alignment', version: 1, method: 'external-transcript', engine: response.model,
    audioSha256: hash, metadataSha256: digest(input.metadata), sourceSha256: review.sourceSha256, responseSha256: digest(input.asrResponse),
    transcriptSha256: review.transcriptSha256, aliasesSha256: review.aliasesSha256,
    wordTimesSha256: digest(JSON.stringify(words)), mappedWordsSha256: digest(JSON.stringify(result)), locale: input.locale,
    aliases, asrResponse: input.asrResponse, words: result };
}

/** The caller supplies the exact raw ASR response; an existing sidecar is never overwritten. */
export async function saveAudioAlignment(audioFile: string, asrResponse: string, locale: string, aliases: TranscriptAlias[] = []) {
  const audio = await readFile(audioFile), metadata = await readFile(`${audioFile}.json`);
  const alignment = createAudioAlignment({ audio, metadata, asrResponse, locale, aliases });
  await writeFile(`${audioFile}.alignment.json`, JSON.stringify(alignment, null, 2), { flag: 'wx' });
  return alignment;
}

/** Existing but invalid sidecars fail closed; absent sidecars leave provider timestamps unchanged. */
export async function effectiveAudioAlignment(audioFile: string, meta: AudioMeta, locale: string) {
  const file = `${audioFile}.alignment.json`;
  if (!existsSync(file)) return { meta, summary: undefined as AlignmentSummary | undefined };
  const bytes = await readFile(file), saved = JSON.parse(bytes.toString('utf8')) as ExternalAlignment;
  const audio = await readFile(audioFile), metadata = await readFile(`${audioFile}.json`);
  assert.deepEqual(JSON.parse(metadata.toString('utf8')), meta, 'TTS metadata changed');
  const verified = createAudioAlignment({ audio, metadata, asrResponse: saved.asrResponse, locale, aliases: saved.aliases });
  assert.deepEqual(saved, verified, 'External alignment sidecar changed or is stale');
  const summary: AlignmentSummary = { method: 'external-transcript', engine: saved.engine, sidecarSha256: digest(bytes), audioSha256: saved.audioSha256, metadataSha256: saved.metadataSha256,
    sourceSha256: saved.sourceSha256, responseSha256: saved.responseSha256, transcriptSha256: saved.transcriptSha256,
    aliasesSha256: saved.aliasesSha256, wordTimesSha256: saved.wordTimesSha256, mappedWordsSha256: saved.mappedWordsSha256 };
  return { meta: { ...meta, sentences: [{ index: 0, text: meta.text, words: saved.words }], alignment: { method: 'external-transcript' as const, engine: saved.engine } }, summary };
}

/** Verify that persisted captions still use the current selected word boundaries. */
export async function assertTimelineAlignments(clips: TimedClip[], locale: string) {
  for (const clip of clips) {
    const meta = JSON.parse(await readFile(`${clip.audioFile}.json`, 'utf8')) as AudioMeta;
    assert.deepEqual(clip.audioMeta, meta, `TTS metadata changed: ${clip.id}`);
    const pcm = await readPcm(clip.audioFile);
    assert.equal(clip.audioDuration, pcm.samples.length / pcm.sampleRate, `Audio duration changed: ${clip.id}`);
    const selected = await effectiveAudioAlignment(clip.audioFile, meta, locale);
    assert.deepEqual(clip.captionAlignment, selected.summary, `Caption alignment selection changed: ${clip.id}`);
    assert.deepEqual(clip.captions, captionsFromWords(selected.meta, clip.audioDuration, locale), `Caption timing differs from selected alignment: ${clip.id}`);
  }
}
