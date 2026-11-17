import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { projectDir, validateSpeechParts, validateEnglishPossessiveClips, type Script } from './project';
import { completeHosting } from './hosting';
import { narrationWritingIssues, narrationSpokenIssues, type NarrationEdit } from './narration';
export async function editScript(source: Script, options: { sourceOnly?: boolean; narrationFile?: string } = {}): Promise<Script> {
  if (options.sourceOnly) return { ...(source.perspective === 'player' ? source : completeHosting(source, source)), sourceOnly: true };
  const file = options.narrationFile || process.env.VIDEO_NARRATION_FILE || (existsSync(`${projectDir}/narration.json`) ? `${projectDir}/narration.json` : `scripts/video/narration-${source.roomId}.json`);
  const completeMatch = source.chapters.some((chapter) => chapter.entries.some((entry) => entry.type === 'game.start' || entry.type === 'review'));
  if (!existsSync(file)) {
    if (source.perspective !== 'player' && completeMatch) throw Error('完整上帝稿尚未撰写');
    return source.perspective === 'player' ? source : completeHosting(source, source);
  }
  const editorial = JSON.parse(await readFile(file, 'utf8')) as { roomId: string; edits: Record<string, NarrationEdit>; speechParts?: unknown; englishPossessiveClips?: unknown };
  if (editorial.roomId !== source.roomId) throw Error('Narration and match do not match');
  if (source.perspective === 'player') {
    if ((editorial as { playerSeat?: number }).playerSeat !== source.playerSeat || Object.keys(editorial.edits).length || editorial.speechParts !== undefined || editorial.englishPossessiveClips !== undefined) throw Error('Player view does not accept editorial narration');
    return source;
  }
  if (completeMatch) {
    const issues = narrationWritingIssues(source, editorial);
    if (issues.length) throw Error(issues.join('；'));
  }
  if (!editorial.edits || typeof editorial.edits !== 'object' || Array.isArray(editorial.edits)) throw Error('Narration edits must be an object');
  for (const edit of Object.values(editorial.edits)) {
    if (!edit || typeof edit !== 'object' || (edit.voiceKey !== undefined && !['judge', 'commentator'].includes(edit.voiceKey))) throw Error('Editorial narration must use the judge or commentator voice');
  }
  if (editorial.speechParts !== undefined) validateSpeechParts(source, editorial.speechParts);
  if (editorial.englishPossessiveClips !== undefined) validateEnglishPossessiveClips({ ...source, ...(editorial.speechParts === undefined ? {} : { speechParts: editorial.speechParts }) }, editorial.englishPossessiveClips);
  const used = new Set<string>();
  const script: Script = { ...source, ...(editorial.englishPossessiveClips === undefined ? {} : { englishPossessiveClips: editorial.englishPossessiveClips }), ...(editorial.speechParts === undefined ? {} : { speechParts: editorial.speechParts }), chapters: source.chapters.map((c) => ({ ...c, entries: c.entries.flatMap((e) => {
    const edit = editorial.edits[e.sourceSeq];
    if (!edit) return [e];
    if (e.seat !== undefined) throw Error('Editorial must not change player speech');
    used.add(String(e.sourceSeq));
    const comments = (edit.after ?? []).map((comment, i) => ({ sourceSeq: e.sourceSeq, type: 'hosting.commentary',
      speaker: '上帝解说', voiceKey: 'commentator', text: comment.text, visibility: e.visibility,
      data: { presentationOnly: true, editorialAfter: true, presentationKey: `commentary-${i + 1}`, replayThrough: e.sourceSeq,
        provenance: '旁白编辑稿：依据锚点之前已发生的事实', editReason: comment.reason } }));
    if (edit.omit) return comments;
    return [{ ...e, text: edit.text ?? e.text, voiceKey: edit.voiceKey ?? e.voiceKey,
      speaker: edit.voiceKey === 'commentator' ? '上帝解说' : '法官', data: { ...e.data, editorial: true, originalText: e.text, editReason: edit.reason } }, ...comments];
  }) })) };
  for (const seq of Object.keys(editorial.edits)) if (!used.has(seq)) throw Error(`Editorial refers to missing event ${seq}`);
  const spoken = completeHosting(source, script);
  if (completeMatch) {
    const issues = narrationSpokenIssues(source, editorial, spoken);
    if (issues.length) throw Error(issues.join('；'));
  }
  return spoken;
}

/** Verify that a persisted complete god-view script is exactly the currently reviewed narration. */
export async function assertFullNarration(source: Script, script: Script, projectPath: string): Promise<void> {
  if (source.perspective === 'player' && script.perspective === 'player') return;
  if (source.perspective !== 'god' || script.perspective !== 'god' || (script as Script & { sourceOnly?: boolean }).sourceOnly) throw Error('完整片不得使用源音稿或混合视角');
  const narrationFile = resolve(projectPath) === resolve(projectDir) && process.env.VIDEO_NARRATION_FILE
    ? process.env.VIDEO_NARRATION_FILE : join(projectPath, 'narration.json');
  const narration = JSON.parse(await readFile(narrationFile, 'utf8')) as { review?: { status?: unknown; method?: unknown; factsChecked?: unknown; playerQuotesUntouched?: unknown; futureResultsNotUsedInProcessCommentary?: unknown } };
  const review = narration.review;
  if (!review || review.status !== 'reviewed' || typeof review.method !== 'string' || !review.method.trim() || review.factsChecked !== true || review.playerQuotesUntouched !== true || review.futureResultsNotUsedInProcessCommentary !== true) throw Error('完整片解说稿尚未完成真实审核');
  const expected = await editScript(source, { narrationFile });
  if (!isDeepStrictEqual(script, expected)) throw Error('完整片脚本与当前审核的解说稿不一致，需重新准备');
}
