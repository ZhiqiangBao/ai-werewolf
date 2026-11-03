import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizedCaptionText } from './timeline';

/** Caller explicitly verifies each original spelling and its independently transcribed alias. */
export interface TranscriptAlias { source: string; transcript: string }
export interface AudioContentInput { audio: Buffer; sourceText: string; transcript: string; locale: string; aliases?: TranscriptAlias[] }
export interface AudioContentReview {
  format: 'werewolf-audio-content-review'; version: 1; audioSha256: string; sourceSha256: string;
  transcriptSha256: string; aliasesSha256: string; locale: string; matches: boolean;
  method: 'external-transcript-comparison';
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** No ASR invocation or automatic source editing: caller supplies independent transcript and audio. */
export function reviewAudioContent(input: AudioContentInput): AudioContentReview {
  assert(Buffer.isBuffer(input.audio) && input.audio.length > 0, 'Audio bytes are required');
  assert(input.sourceText.trim().length > 0, 'Source text is required');
  const aliases = input.aliases ?? [];
  assert(new Set(aliases.map((item) => item.transcript)).size === aliases.length, 'Duplicate transcript alias');
  assert(new Set(aliases.map((item) => item.source)).size === aliases.length, 'Duplicate source alias');
  for (const item of aliases) {
    assert(item.source.trim() && item.transcript.trim() && input.sourceText.includes(item.source) && input.transcript.includes(item.transcript), 'Alias must occur in the source and independent transcript');
  }
  const sorted = [...aliases].sort((a, b) => b.transcript.length - a.transcript.length);
  let mapped = '';
  for (let i = 0; i < input.transcript.length;) {
    const alias = sorted.find((item) => input.transcript.startsWith(item.transcript, i));
    if (alias) { mapped += alias.source; i += alias.transcript.length; }
    else { mapped += input.transcript[i]; i++; }
  }
  const expected = normalizedCaptionText(input.sourceText, input.locale);
  const actual = normalizedCaptionText(mapped, input.locale);
  return { format: 'werewolf-audio-content-review', version: 1, audioSha256: digest(input.audio), sourceSha256: digest(input.sourceText),
    transcriptSha256: digest(input.transcript), aliasesSha256: digest(JSON.stringify(aliases)), locale: input.locale,
    matches: expected.length > 0 && actual === expected, method: 'external-transcript-comparison' };
}

/** Recompute all bindings so a stale report cannot validate a different audio file or transcript. */
export function assertAudioContentReview(review: AudioContentReview, input: AudioContentInput): void {
  const actual = reviewAudioContent(input);
  assert.deepEqual(review, actual, 'Audio content review does not match current audio and transcript');
  assert(actual.matches, 'Independent transcript does not match source text');
}
