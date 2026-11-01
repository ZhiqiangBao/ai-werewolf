import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { buildRuleCard } from '../../packages/engine/src/index';
import { editScript } from './editorial';
import { buildClips, loadScript, dataDir, projectDir, roomId, type Clip, type Script, type TimedClip } from './project';

const selectionFile = process.argv.find((a) => a.startsWith('--selection='))?.slice(12);
if (!selectionFile) throw Error('Provide --selection=FILE with explicit source events and optional part numbers');
const originalDir = resolve(dataDir, 'video', roomId);
assert.notEqual(projectDir, originalDir, 'Set VIDEO_PROJECT_DIR to a separate sample directory; preserve the complete film');
const selection = JSON.parse(await readFile(selectionFile, 'utf8')) as {
  description: string; sections: { title: string; sourceSeqs: number[]; parts?: Record<string, number[]> }[];
};
const source = existsSync(`${originalDir}/source.json`) ? JSON.parse(await readFile(`${originalDir}/source.json`, 'utf8')) as Script : await loadScript();
if (!source.ruleCard) {
  const record = JSON.parse(await readFile(`${dataDir}/rooms/${roomId}.json`, 'utf8'));
  source.ruleCard = buildRuleCard(record.rules);
}
const script = { ...await editScript(source), sample: true };
const full = buildClips(script);
const clips: Clip[] = selection.sections.flatMap((section) => full.filter((c) => section.sourceSeqs.includes(c.sourceSeq) &&
  (!section.parts?.[c.sourceSeq] || section.parts[c.sourceSeq].includes(c.part))).map((c) => ({ ...c, data: { ...c.data, sampleSection: section.title } })));
assert(clips.length > 0);
assert.equal(new Set(clips.map((c) => c.id)).size, clips.length, 'Duplicate sample selection');
for (let i = 1; i < clips.length; i++) assert(clips[i].sourceSeq >= clips[i - 1].sourceSeq, 'Sample must preserve the match chronology');
const cached = existsSync(`${originalDir}/timeline.json`) ? JSON.parse(await readFile(`${originalDir}/timeline.json`, 'utf8')) as { clips: TimedClip[] } : { clips: [] as TimedClip[] };
await mkdir(`${projectDir}/audio`, { recursive: true });
let reused = 0;
for (const c of clips) {
  const old = cached.clips.find((o) => o.voiceKey === c.voiceKey && o.spokenText === c.spokenText);
  if (!old) continue;
  await copyFile(old.audioFile, c.audioFile);
  await copyFile(old.audioFile + '.json', c.audioFile + '.json');
  reused++;
}
await writeFile(`${projectDir}/source.json`, JSON.stringify(source, null, 2));
await writeFile(`${projectDir}/script.json`, JSON.stringify(script, null, 2));
await writeFile(`${projectDir}/clips.json`, JSON.stringify(clips, null, 2));
await copyFile(`${originalDir}/voices.json`, `${projectDir}/voices.json`);
await writeFile(`${projectDir}/sample-selection.json`, JSON.stringify({ ...selection, roomId, reusedAudio: reused,
  clips: clips.map((c) => ({ id: c.id, sourceSeq: c.sourceSeq, part: c.part, type: c.type, presentationOnly: !!c.data.presentationOnly, text: c.text })) }, null, 2));
console.log(JSON.stringify({ projectDir, clips: clips.length, reusedAudio: reused, newAudio: clips.length - reused }));
