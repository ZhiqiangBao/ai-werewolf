import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { TranscriptAlias } from './audio-content-review';
import { normalizedCaptionText } from './timeline';

export interface EditMetric { edits: number; referenceUnits: number; rate: number }
export interface TranscriptComparison { locale: string; referenceSha256: string; aliasPolicySha256: string; unit: 'word' | 'character'; raw: EditMetric; normalized: EditMetric; withAliases: EditMetric; aliasesApplied: { source: string; transcript: string; occurrences: number }[] }
const contractions: Record<string, string> = {
  "i'm": 'i am', "you're": 'you are', "we're": 'we are', "they're": 'they are', "it's": 'it is', "that's": 'that is',
  "i've": 'i have', "we've": 'we have', "they've": 'they have', "i'll": 'i will', "you'll": 'you will', "we'll": 'we will',
  "can't": 'can not', "cannot": 'can not', "won't": 'will not', "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not', "shouldn't": 'should not', "wouldn't": 'would not', "couldn't": 'could not',
};
const small: Record<string, number> = Object.fromEntries(['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'].map((s, i) => [s, i]));
const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Deterministic EN case/punctuation/contraction/number normalization, retaining all numeric values. */
function englishWords(text: string): string[] {
  const expanded = text.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[a-z]+(?:'[a-z]+)?/g, (word) => contractions[word] ?? word);
  const raw = [...expanded.matchAll(/\d+(?:\.\d+)?|[\p{L}]+(?:'[\p{L}]+)?/gu)].map((m) => ({ value: m[0], start: m.index!, end: m.index! + m[0].length }));
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i].value;
    let n = Object.hasOwn(small, token) ? small[token] : Object.hasOwn(tens, token) ? tens[token] : undefined;
    if (n !== undefined && Object.hasOwn(tens, token) && raw[i + 1] && Object.hasOwn(small, raw[i + 1].value) && small[raw[i + 1].value] > 0 && small[raw[i + 1].value] < 10 && /^[\s-]+$/.test(expanded.slice(raw[i].end, raw[i + 1].start))) n += small[raw[++i].value];
    if (n !== undefined && raw[i + 1]?.value === 'point') {
      let j = i + 2, digits = '';
      while (raw[j] && Object.hasOwn(small, raw[j].value) && small[raw[j].value] < 10 && digits.length < 6) digits += String(small[raw[j++].value]);
      if (digits) { out.push(`${n}.${digits}`); i = j - 1; continue; }
    }
    out.push(n === undefined ? token : String(n));
  }
  return out;
}

function units(text: string, locale: string, normalized: boolean) {
  const language = new Intl.Locale(locale).language;
  if (language === 'en') return normalized ? englishWords(text) : text.match(/\S+/gu) ?? [];
  return [...(normalized ? normalizedCaptionText(text.normalize('NFKC'), locale) : text)];
}

export function levenshtein(a: readonly string[], b: readonly string[]) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = next;
  }
  return prev[b.length];
}
function metric(reference: string[], actual: string[]): EditMetric {
  assert(reference.length > 0, 'Comparison source is empty');
  const edits = levenshtein(reference, actual);
  return { edits, referenceUnits: reference.length, rate: edits / reference.length };
}

/** Aliases are opt-in for this clip only; the raw transcript and raw score remain unchanged. */
export function compareAsrText(source: string, transcript: string, locale: string, aliases: TranscriptAlias[] = []): TranscriptComparison {
  assert(source.trim(), 'Comparison source is empty');
  assert(new Set(aliases.map((a) => a.transcript)).size === aliases.length && new Set(aliases.map((a) => a.source)).size === aliases.length, 'Duplicate comparison alias');
  for (const alias of aliases) assert(alias.source.trim() && alias.transcript.trim() && source.includes(alias.source), 'Comparison alias must be explicitly present in the source');
  const ordered = [...aliases].sort((a, b) => b.transcript.length - a.transcript.length);
  const counts = new Map(aliases.map((a) => [a.transcript, 0])); let mapped = '';
  for (let i = 0; i < transcript.length;) {
    const hit = ordered.find((a) => transcript.startsWith(a.transcript, i));
    if (hit) { mapped += hit.source; counts.set(hit.transcript, counts.get(hit.transcript)! + 1); i += hit.transcript.length; }
    else mapped += transcript[i++];
  }
  const ref = units(source, locale, true);
  return { locale, referenceSha256: createHash('sha256').update(JSON.stringify(ref)).digest('hex'), aliasPolicySha256: createHash('sha256').update(JSON.stringify(aliases)).digest('hex'), unit: new Intl.Locale(locale).language === 'en' ? 'word' : 'character',
    raw: metric(units(source, locale, false), units(transcript, locale, false)),
    normalized: metric(ref, units(transcript, locale, true)), withAliases: metric(ref, units(mapped, locale, true)),
    aliasesApplied: aliases.map((a) => ({ ...a, occurrences: counts.get(a.transcript)! })) };
}

/** Quantitative criteria alone never approve semantic or overall equivalence. */
export function assessAsrThreshold(candidate: TranscriptComparison, bestCloud: TranscriptComparison) {
  assert(candidate.locale === bestCloud.locale && candidate.referenceSha256 === bestCloud.referenceSha256 && candidate.aliasPolicySha256 === bestCloud.aliasPolicySha256 && candidate.withAliases.referenceUnits === bestCloud.withAliases.referenceUnits, 'Comparisons must use the same reference and alias policy');
  const n = candidate.withAliases.referenceUnits, allowance = Math.max(1, Math.ceil(n * .01));
  const absolutePass = candidate.withAliases.rate <= .05, relativePass = candidate.withAliases.edits <= bestCloud.withAliases.edits + allowance;
  return { absoluteLimit: .05, extraErrorsAllowed: allowance, absolutePass, relativePass, quantitativePass: absolutePass && relativePass,
    criticalReview: 'required' as const, criticalReviewAreas: ['numbers', 'negation', 'names', 'sentence-additions-omissions'], qualityEquivalent: 'not-determined' as const };
}

export function assessAgainstClouds(candidate: TranscriptComparison, clouds: TranscriptComparison[]) {
  assert(clouds.length > 0, 'At least one cloud comparison is required');
  for (const cloud of clouds) assessAsrThreshold(candidate, cloud);
  const bestCloudIndex = clouds.reduce((best, item, index) => item.withAliases.edits < clouds[best].withAliases.edits ? index : best, 0);
  return { bestCloudIndex, bestCloudEdits: clouds[bestCloudIndex].withAliases.edits, ...assessAsrThreshold(candidate, clouds[bestCloudIndex]) };
}
