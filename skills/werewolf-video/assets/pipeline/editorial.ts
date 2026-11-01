import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { projectDir, type Script } from './project';
import { completeHosting } from './hosting';
import type { NarrationEdit } from './narration';
export async function editScript(source: Script): Promise<Script> {
  const file = process.env.VIDEO_NARRATION_FILE || (existsSync(`${projectDir}/narration.json`) ? `${projectDir}/narration.json` : `scripts/video/narration-${source.roomId}.json`);
  if (!existsSync(file)) return completeHosting(source, source);
  const editorial = JSON.parse(await readFile(file, 'utf8')) as { roomId: string; edits: Record<string, NarrationEdit> };
  if (editorial.roomId !== source.roomId) throw Error('Narration and match do not match');
  const used = new Set<string>();
  const script: Script = { ...source, chapters: source.chapters.map((c) => ({ ...c, entries: c.entries.flatMap((e) => {
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
  return completeHosting(source, script);
}
