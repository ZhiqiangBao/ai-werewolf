import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildClips, clipVoiceProfile, loadScript, projectDir, type Script, type VoiceCatalog } from './project';
import { editScript } from './editorial';
import { assertPlayerSources } from './integrity';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Checks recorded preparation and structure; semantic editorial quality still needs a real review. */
export function materialIssues(source: Script, narration: unknown, voices: VoiceCatalog): string[] {
  const issues: string[] = [];
  if (!object(narration)) return ['narration.json 必须是对象'];
  if (narration.roomId !== source.roomId) issues.push('解说稿 roomId 与本局不一致');
  const review = narration.review;
  if (!object(review) || review.status !== 'reviewed' || !text(review.method) ||
    review.factsChecked !== true || review.playerQuotesUntouched !== true || review.futureResultsNotUsedInProcessCommentary !== true) {
    issues.push('旁白尚未完成审核：按 commentary.md 编写开场、点评与收尾，逐句核对后填写 review；不要直接把模板标为已审核');
  }
  const entries = new Map(source.chapters.flatMap((chapter) => chapter.entries).map((entry) => [String(entry.sourceSeq), entry]));
  if (!object(narration.edits)) issues.push('解说稿缺少 edits 对象');
  else for (const [seq, edit] of Object.entries(narration.edits)) {
    const entry = entries.get(seq);
    if (!entry) issues.push(`编辑锚点 ${seq} 不在本局可朗读事件中`);
    else if (entry.seat !== undefined) issues.push(`编辑锚点 ${seq} 是玩家原话，不能修改或插入点评`);
    if (!object(edit)) { issues.push(`编辑 ${seq} 必须是对象`); continue; }
    if (!text(edit.reason)) issues.push(`编辑 ${seq} 缺少事实依据 reason`);
    if (edit.text !== undefined && !text(edit.text)) issues.push(`编辑 ${seq} 的 text 必须是非空文字`);
    if (edit.omit !== undefined && typeof edit.omit !== 'boolean') issues.push(`编辑 ${seq} 的 omit 必须是布尔值`);
    if (edit.voiceKey !== undefined && (!text(edit.voiceKey) || !voices?.profiles?.[edit.voiceKey])) issues.push(`编辑 ${seq} 的 voiceKey 没有对应音色`);
    if (edit.after !== undefined && (!Array.isArray(edit.after) || edit.after.some((item: unknown) => !object(item) || !text(item.text) || !text(item.reason)))) {
      issues.push(`编辑 ${seq} 的 after 必须逐句包含非空 text 与 reason`);
    }
  }
  if (!text(voices?.model) || !object(voices?.profiles)) issues.push('声音表缺少 model 或 profiles');
  for (const key of new Set(['judge', 'commentator', ...source.cast.map((cast) => cast.voiceKey)])) {
    const profile = voices?.profiles?.[key];
    if (!profile || !text(profile.voice) || !Number.isFinite(profile.rate) || profile.rate <= 0 || typeof profile.instruction !== 'string') {
      issues.push(`音色 ${key} 缺失或 voice／rate／instruction 无效`);
    }
  }
  return issues;
}

export async function inspectMaterials(source?: Script, selectedVoices?: VoiceCatalog) {
  const script = source ?? await loadScript();
  const narrationFile = resolve(process.env.VIDEO_NARRATION_FILE || `${projectDir}/narration.json`);
  const voiceFile = resolve(process.env.VIDEO_VOICES_FILE || `${projectDir}/voices.json`);
  const issues: string[] = [];
  let narration: unknown, narrationLoaded = false, voices = selectedVoices, voicesLoaded = selectedVoices !== undefined;
  try { narration = JSON.parse(await readFile(narrationFile, 'utf8')); narrationLoaded = true; }
  catch { issues.push(`无法读取解说稿：${narrationFile}`); }
  if (!voicesLoaded) try { voices = JSON.parse(await readFile(voiceFile, 'utf8')) as VoiceCatalog; voicesLoaded = true; }
  catch { issues.push(`无法读取声音表：${voiceFile}`); }
  let clips = 0;
  if (narrationLoaded && voicesLoaded) {
    issues.push(...materialIssues(script, narration, voices!));
    if (!issues.length) try {
      const edited = await editScript(script), planned = buildClips(edited);
      assertPlayerSources(script, edited, planned);
      for (const clip of planned) clipVoiceProfile(voices!, clip);
      clips = planned.length;
      if (!clips) issues.push('本局没有可制作的语音片段');
    } catch (error) { issues.push(error instanceof Error ? error.message : '编辑稿或原话完整性检查失败'); }
  }
  return { roomId: script.roomId, ready: !issues.length, narrationFile, voiceFile, issues, clips,
    externalServicesCalled: false, editorialQuality: '由制作者审核；程序只检查材料、审核记录、音色参数与原话完整性' };
}
