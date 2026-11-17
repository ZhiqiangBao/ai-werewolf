import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { buildRuleCard } from '../../packages/engine/src/index';
import { editScript } from './editorial';
import { buildClips, loadScript, dataDir, projectDir, roomId, type Clip, type Script, loadVoices } from './project';

const selectionFile = process.argv.find((a) => a.startsWith('--selection='))?.slice(12);
if (!selectionFile) throw Error('Provide --selection=FILE with explicit source events and optional part numbers');
const playerSeat = process.env.VIDEO_PLAYER_SEAT;
const originalDir = resolve(process.env.VIDEO_SOURCE_PROJECT || resolve(dataDir, 'video', playerSeat ? `${roomId}-player-${playerSeat}` : roomId));
assert.notEqual(projectDir, originalDir, 'Set VIDEO_PROJECT_DIR to a separate sample directory; preserve the complete film');
if (existsSync(projectDir) && (await readdir(projectDir)).length) {
  const priorSelection = `${projectDir}/sample-selection.json`;
  if (!existsSync(priorSelection)) throw Error('Sample directory contains unrelated files');
  const previous = JSON.parse(await readFile(priorSelection, 'utf8'));
  const requested = JSON.parse(await readFile(selectionFile, 'utf8'));
  assert.equal(previous.roomId, roomId, 'Sample directory belongs to another room');
  assert.deepEqual(previous.sections, requested.sections, 'Sample selection changed; use a new directory');
}
const selection = JSON.parse(await readFile(selectionFile, 'utf8')) as {
  description: string; sections: { title: string; sourceSeqs: number[]; parts?: Record<string, number[]> }[];
};
const canonical = await loadScript();
const source = existsSync(`${originalDir}/source.json`) ? JSON.parse(await readFile(`${originalDir}/source.json`, 'utf8')) as Script : canonical;
assert.deepEqual(source, canonical, 'Sample cannot reuse another view or stale source');
if (!source.ruleCard && !playerSeat) {
  const record = JSON.parse(await readFile(`${dataDir}/rooms/${roomId}.json`, 'utf8'));
  source.ruleCard = buildRuleCard(record.rules);
}
if (!process.env.VIDEO_NARRATION_FILE && existsSync(`${originalDir}/narration.json`)) process.env.VIDEO_NARRATION_FILE = `${originalDir}/narration.json`;
const script = { ...await editScript(source, process.env.VIDEO_SOURCE_ONLY === '1' ? { sourceOnly: true } : undefined), sample: true };
const full = buildClips(script);
for (const section of selection.sections) {
  assert(Array.isArray(section.sourceSeqs) && section.sourceSeqs.length, 'Sample section has no source events');
  for (const seq of section.sourceSeqs) {
    const parts = full.filter(clip => clip.sourceSeq === seq).map(clip => clip.part);
    assert(parts.length && (!section.parts?.[seq] || (section.parts[seq].length && section.parts[seq].every(part => parts.includes(part)))), 'Selected sample event or part is absent: ' + seq);
  }
}
const clips: Clip[] = selection.sections.flatMap((section) => full.filter((c) => section.sourceSeqs.includes(c.sourceSeq) &&
  (!section.parts?.[c.sourceSeq] || section.parts[c.sourceSeq].includes(c.part))).map((c) => ({ ...c, data: { ...c.data, sampleSection: section.title } })));
assert(clips.length > 0);
assert.equal(new Set(clips.map((c) => c.id)).size, clips.length, 'Duplicate sample selection');
for (let i = 1; i < clips.length; i++) assert(clips[i].sourceSeq >= clips[i - 1].sourceSeq, 'Sample must preserve the match chronology');
await mkdir(`${projectDir}/audio`, { recursive: true });
await writeFile(`${projectDir}/source.json`, JSON.stringify(source, null, 2));
await writeFile(`${projectDir}/script.json`, JSON.stringify(script, null, 2));
await writeFile(`${projectDir}/clips.json`, JSON.stringify(clips, null, 2));
if (!existsSync(`${projectDir}/voices.json`)) {
  if (existsSync(`${originalDir}/voices.json`)) await copyFile(`${originalDir}/voices.json`, `${projectDir}/voices.json`);
  else await writeFile(`${projectDir}/voices.json`, JSON.stringify(await loadVoices(), null, 2));
}
if (existsSync(`${originalDir}/avatar-theme.json`)) await copyFile(`${originalDir}/avatar-theme.json`, `${projectDir}/avatar-theme.json`);
if (existsSync(`${originalDir}/workflow-status.json`)) await copyFile(`${originalDir}/workflow-status.json`, `${projectDir}/workflow-status.json`);
if (playerSeat && existsSync(`${originalDir}/narration.json`) && !existsSync(`${projectDir}/narration.json`)) await copyFile(`${originalDir}/narration.json`, `${projectDir}/narration.json`);
await writeFile(`${projectDir}/sample-selection.json`, JSON.stringify({ ...selection, roomId,
  clips: clips.map((c) => ({ id: c.id, sourceSeq: c.sourceSeq, part: c.part, type: c.type, presentationOnly: !!c.data.presentationOnly, text: c.text })) }, null, 2));
console.log(JSON.stringify({ projectDir, clips: clips.length }));
