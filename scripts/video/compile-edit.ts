import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { effectiveAudioAlignment } from './audio-alignment';
import { sourceCaptionWords } from './timeline';
import type { Clip, Script } from './project';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const obj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
export function fields(value: any, allowed: string[], label: string) {
  assert(obj(value), `${label} must be an object`);
  for (const key of Object.keys(value)) assert(allowed.includes(key), `Unknown ${label} field: ${key}`);
}
export async function readJob(path: string, allowed: string[]) {
  const file = resolve(path), job = JSON.parse(await readFile(file, 'utf8'));
  fields(job, allowed, 'job');
  const pathAt = (key: string, required = true) => {
    const value = job[key];
    assert(!required || (typeof value === 'string' && value.trim()), `Missing ${key}`);
    assert(value === undefined || (typeof value === 'string' && value.trim()), `Invalid ${key}`);
    return value === undefined ? undefined : resolve(dirname(file), value);
  };
  return { job, pathAt };
}
/** Match exact original text, allowing only adjacent original punctuation at range edges. */
export function locateQuote(source: string, words: { text: string }[], quote: string, occurrence?: number) {
  assert(words.map(w => w.text).join('') === source, 'Word mapping differs from source');
  assert(typeof quote === 'string' && quote.length && /[\p{L}\p{N}]/u.test(quote), 'Empty quote');
  const chars = Array.from(source), needle = Array.from(quote), spoken = (s: string) => /[\p{L}\p{N}]/u.test(s);
  const offsets = [0]; for (const word of words) offsets.push(offsets.at(-1)! + Array.from(word.text).length);
  const matches: { wordStart: number; wordEnd: number }[] = [];
  for (let a = 0; a < words.length; a++) for (let b = a + 1; b <= words.length; b++) {
    const rawStart = offsets[a], rawEnd = offsets[b]; let maxStart = rawStart, minEnd = rawEnd, maxEnd = rawEnd;
    while (maxStart < rawEnd && !spoken(chars[maxStart])) maxStart++;
    while (minEnd > rawStart && !spoken(chars[minEnd - 1])) minEnd--;
    while (maxEnd < chars.length && !spoken(chars[maxEnd])) maxEnd++;
    for (let start = rawStart; start <= maxStart; start++) {
      const end = start + needle.length;
      if (end >= minEnd && end <= maxEnd && chars.slice(start, end).join('') === quote) { matches.push({ wordStart: a, wordEnd: b }); break; }
    }
  }
  assert(matches.length, 'Quote does not match contiguous source word boundaries');
  if (occurrence === undefined) assert.equal(matches.length, 1, 'Ambiguous quote; specify occurrence');
  else assert(Number.isInteger(occurrence) && occurrence >= 1 && occurrence <= matches.length, 'Invalid occurrence');
  return matches[(occurrence ?? 1) - 1];
}
export async function compileEdit(jobPath: string, checkOnly = false) {
  const { job, pathAt } = await readJob(jobPath, ['sourceProject', 'manuscript', 'output', 'reviewFile']);
  const sourceDir = pathAt('sourceProject')!, manuscriptPath = pathAt('manuscript')!, output = pathAt('output')!, reviewPath = pathAt('reviewFile', false);
  const rel = relative(sourceDir, output);
  assert(rel && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) && output !== manuscriptPath && output !== reviewPath && output !== resolve(jobPath), 'Output must be separate from inputs and source project');
  const manuscriptBytes = await readFile(manuscriptPath), raw = JSON.parse(manuscriptBytes.toString('utf8'));
  const manuscript = Array.isArray(raw) ? { items: raw } : raw;
  fields(manuscript, ['roomId', 'title', 'theme', 'items'], 'manuscript');
  const sourceBytes = await readFile(join(sourceDir, 'source.json')), source = JSON.parse(sourceBytes.toString()) as Script;
  const clips = JSON.parse(await readFile(join(sourceDir, 'clips.json'), 'utf8')) as Clip[];
  const theme = JSON.parse(await readFile(join(sourceDir, 'avatar-theme.json'), 'utf8')).theme;
  assert(source.roomId && typeof theme === 'string' && theme, 'Invalid source or theme');
  assert(manuscript.roomId === undefined || manuscript.roomId === source.roomId, 'Wrong room');
  assert(manuscript.theme === undefined || manuscript.theme === theme, 'Wrong theme');
  assert(Array.isArray(manuscript.items) && manuscript.items.length, 'Manuscript has no items');
  let reviewed = false, review: unknown;
  if (reviewPath) {
    review = JSON.parse(await readFile(reviewPath, 'utf8'));
    const r = review as any;
    const approved = (r?.approved === true || r?.status === 'approved') && r?.approved !== false && (r?.status === undefined || r.status === 'approved');
    const hashes = [r?.manuscriptSha256, ...Object.values(r?.checks ?? {}).map((entry: any) => entry?.sha256)];
    assert(obj(review) && approved && hashes.includes(sha(manuscriptBytes)), 'Review is not approved or manuscript SHA mismatch');
    reviewed = true;
  }
  const ids = new Set<string>(); let lastIndex = -1, lastSeq = -1;
  const items = [];
  for (const item of manuscript.items) {
    assert(obj(item) && typeof item.id === 'string' && item.id && !ids.has(item.id), 'Invalid or duplicate item id'); ids.add(item.id);
    if (item.kind === 'narration') {
      fields(item, ['kind', 'id', 'text', 'afterSourceSeq', 'storyCard', 'reason', 'targetSeconds', 'changedFromDraft', 'delivery'], 'narration');
      assert(typeof item.text === 'string' && item.text.trim() && Number.isInteger(item.afterSourceSeq) && item.afterSourceSeq >= lastSeq && source.events.some(e => e.sourceSeq === item.afterSourceSeq), 'Invalid narration');
      lastSeq = item.afterSourceSeq; items.push(item); continue;
    }
    fields(item, ['kind', 'id', 'sourceClipId', 'sourceSeq', 'quote', 'reason', 'storyCard', 'occurrence', 'changedFromDraft'], 'source item');
    assert(item.kind === 'source' && typeof item.reason === 'string' && item.reason.trim(), 'Invalid source item or reason');
    let candidates = typeof item.sourceClipId === 'string' ? clips.filter(c => c.id === item.sourceClipId) : clips.filter(c => Number.isInteger(item.sourceSeq) && c.sourceSeq === item.sourceSeq);
    assert.equal(candidates.length, 1, 'Source clip must be uniquely identified');
    const clip = candidates[0], index = clips.indexOf(clip);
    assert(index > lastIndex && clip.sourceSeq >= lastSeq, 'Source clips out of order'); lastIndex = index; lastSeq = clip.sourceSeq;
    const file = join(sourceDir, 'audio', `${clip.id}.wav`), audio = await readFile(file), meta = JSON.parse(await readFile(file + '.json', 'utf8'));
    assert(meta.text === clip.spokenText && meta.bytes === audio.length, 'Audio metadata differs from source');
    const aligned = await effectiveAudioAlignment(file, meta, source.locale ?? 'zh-CN');
    const words = sourceCaptionWords(aligned.meta, source.locale ?? 'zh-CN');
    assert(words.length && words.every((w, i) => Number.isFinite(w.begin_time) && Number.isFinite(w.end_time) && w.begin_time >= 0 && w.end_time > w.begin_time && (!i || w.begin_time >= words[i - 1].begin_time && w.end_time >= words[i - 1].end_time)), 'Invalid word timings');
    const range = locateQuote(clip.spokenText, words, item.quote, item.occurrence);
    items.push({ kind: 'source', id: item.id, sourceClipId: clip.id, ...range, quote: item.quote, reason: item.reason, ...(item.changedFromDraft === undefined ? {} : { changedFromDraft: item.changedFromDraft }), ...(item.storyCard === undefined ? {} : { storyCard: item.storyCard }), audioSha256: sha(audio), timingSha256: sha(Buffer.from(JSON.stringify(words))) });
  }
  const result = { roomId: source.roomId, sourceSha256: sha(sourceBytes), reviewed, theme, ...(manuscript.title === undefined ? {} : { title: manuscript.title }), items, ...(review === undefined ? {} : { review }) };
  if (!checkOnly) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n'); }
  return { ...result, planned: checkOnly };
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('/compile-edit.ts')) {
  const args = process.argv.slice(2); assert(args.every(a => a.startsWith('--job=') || a === '--check-only') && args.filter(a => a.startsWith('--job=')).length === 1, 'Required: --job=JSON [--check-only]');
  console.log(JSON.stringify(await compileEdit(args.find(a => a.startsWith('--job='))!.slice(6), args.includes('--check-only'))));
}
