import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Script } from './project';
export async function editScript(source: Script): Promise<Script> {
  const file = process.env.VIDEO_NARRATION_FILE || `scripts/video/narration-${source.roomId}.json`;
  if (!existsSync(file)) return source;
  const editorial = JSON.parse(await readFile(file, 'utf8')) as { roomId: string; edits: Record<string, { omit?: boolean; text?: string; voiceKey?: string; reason: string }> };
  if (editorial.roomId !== source.roomId) throw Error('Narration and match do not match');
  const used = new Set<string>();
  const script: Script = { ...source, chapters: source.chapters.map((c) => ({ ...c, entries: c.entries.flatMap((e) => {
    const edit = editorial.edits[e.sourceSeq];
    if (!edit) return [e];
    if (e.seat !== undefined) throw Error('Editorial must not change player speech');
    used.add(String(e.sourceSeq));
    if (edit.omit) return [];
    return [{ ...e, text: edit.text ?? e.text, voiceKey: edit.voiceKey ?? e.voiceKey,
      speaker: edit.voiceKey === 'commentator' ? '上帝解说' : '法官', data: { ...e.data, editorial: true, originalText: e.text, editReason: edit.reason } }];
  }) })) };
  for (const seq of Object.keys(editorial.edits)) if (!used.has(seq)) throw Error(`Editorial refers to missing event ${seq}`);
  return script;
}
