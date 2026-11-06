/** English cue layout uses submitted text and the original provider time boundaries. */
type TimedText = { text: string; begin_time: number; end_time: number };
type Unit = { text: string; begin: number; end: number; first: number; last: number };

function unitsFromWords(words: TimedText[]): Unit[] {
  const text = words.map(w => w.text).join('');
  const ranges: { start: number; end: number }[] = []; let offset = 0;
  for (const w of words) { ranges.push({ start: offset, end: offset + w.text.length }); offset += w.text.length; }
  const units: Unit[] = []; let prefix = '';
  for (const match of text.matchAll(/\s*\S+|\s+$/gu)) {
    const start = match.index, end = start + match[0].length;
    const matching = ranges.map((r, i) => ({ ...r, i })).filter(r => r.start < end && r.end > start && /[\p{L}\p{N}]/u.test(text.slice(Math.max(start, r.start), Math.min(end, r.end))));
    if (!matching.length) { if (units.length) units[units.length - 1].text += match[0]; else prefix += match[0]; continue; }
    const first = matching[0].i, last = matching[matching.length - 1].i;
    const previous = units.at(-1);
    if (previous && first <= previous.last) {
      previous.text += match[0]; previous.end = words[last].end_time; previous.last = last;
    } else { units.push({ text: prefix + match[0], begin: words[first].begin_time, end: words[last].end_time, first, last }); prefix = ''; }
  }
  return units;
}

const weakEnding = /^(?:a|an|the|this|that|these|those|my|your|his|her|its|our|their|player|players|am|is|are|was|were|be|been|being|do|does|did|have|has|had|will|would|shall|should|can|cannot|could|may|might|must|to|of|in|on|at|for|with|from|by|as|than|about|against|into|onto|through|over|under|between|among|without|within|after|before|until|upon|and|or|but|because|when|while|whether|which|if|who|that|he|she|it|they|we|i|you|not|no|never|only|real|fake|plain)$/i;
const clauseBeginning = /^(?:and|but|because|so|if|when|while|whether|which|who|though|although|then)$/i;
function lexical(text: string) { return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []); }
function boundaryCost(left: string, right: string) {
  const l = lexical(left).at(-1) ?? '', r = lexical(right)[0] ?? '';
  const sentenceEnd = /[.!?]["'’”)]*\s*$/u.test(left);
  const contraction = /(?:n['’]t|['’](?:m|re|ve|ll|d|s))$/i.test(l);
  if (sentenceEnd) return 0;
  // Arbitrary word boundaries are a last resort; punctuation or a clause opener
  // offers a much more legible place to divide a long sentence.
  let score = 22;
  if (/[,;:—–-]["'’”)]*\s*$/u.test(left)) score = 3;
  if (clauseBeginning.test(r)) score = Math.min(score, 4);
  if (weakEnding.test(l) || contraction) score += 90;
  if (/^(?:player|seat)$/i.test(l) && /^\d/.test(r)) score += 100;
  if (/^(?:real|fake|plain)$/i.test(l) && /^(?:seer|witch|villager|hunter|wolf|werewolf)$/i.test(r)) score += 100;
  if (/\b(?:seer|witch|villager|hunter|wolf|werewolf)\s*$/i.test(left) && /^\s*or\s+(?:seer|witch|villager|hunter|wolf|werewolf)\b/i.test(right)) score += 100;
  if (/\b(?:seer|witch|villager|hunter|wolf|werewolf)\s+or\s*$/i.test(left) && /^\s*(?:seer|witch|villager|hunter|wolf|werewolf)\b/i.test(right)) score += 100;
  return score;
}

/** Boundaries are chosen at whole words, favoring natural clauses over hard length caps. */
export function englishCaptionGroups(words: TimedText[]): { text: string; begin_time: number; end_time: number }[] {
  const units = unitsFromWords(words), n = units.length;
  const cost = Array<number>(n + 1).fill(Infinity), next = Array<number>(n).fill(n); cost[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let text = '';
    for (let j = i; j < n; j++) {
      text += units[j].text;
      const count = lexical(text).length, chars = text.trim().length, seconds = (units[j].end - units[i].begin) / 1000;
      const final = j === n - 1, endSentence = /[.!?]["'’”)]*\s*$/u.test(text);
      let penalty = Math.max(0, count - 18) ** 2 * .18 + Math.max(0, chars - 105) ** 2 * .004 + Math.max(0, seconds - 5.2) ** 2 * .8;
      penalty += Math.max(0, 5 - count) * (endSentence ? .25 : 1.2);
      if (seconds < 1.5 && !endSentence) penalty += (1.5 - seconds) * 1.5;
      if (final && count === 1 && i > 0) penalty += 15;
      if (!final) penalty += 1 + boundaryCost(text, units[j + 1].text);
      const candidate = penalty + cost[j + 1];
      if (candidate < cost[i]) { cost[i] = candidate; next[i] = j + 1; }
      if (endSentence) break;
    }
  }
  const result: { text: string; begin_time: number; end_time: number }[] = [];
  for (let i = 0; i < n;) { const j = next[i]; result.push({ text: units.slice(i, j).map(u => u.text).join(''), begin_time: units[i].begin, end_time: units[j - 1].end }); i = j; }
  return result;
}

/** Insert a visual break only; callers may keep the original semantic cue unchanged. */
export function wrapEnglishCaption(text: string, target = 32): string {
  const matches = [...text.matchAll(/\s+/gu)].filter(m => m.index > 0 && m.index + m[0].length < text.length);
  if (text.length <= target || !matches.length) return text;
  let best = matches[0], bestScore = Infinity;
  for (const match of matches) {
    const left = text.slice(0, match.index), right = text.slice(match.index + match[0].length);
    const score = Math.abs(left.length - right.length) + Math.max(0, Math.max(left.length, right.length) - target) * .3 + boundaryCost(left, right);
    if (score < bestScore) { best = match; bestScore = score; }
  }
  return text.slice(0, best.index) + '\n' + text.slice(best.index + best[0].length);
}
