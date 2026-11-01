import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { projectDir, loadScript, loadVoices, dataDir } from './project';
import { draftNarration } from './narration';
const script = await loadScript(); await mkdir(projectDir, { recursive: true });
const narrationFile = `${projectDir}/narration.json`, voiceFile = `${projectDir}/voices.json`;
if (!existsSync(narrationFile)) {
  const example = `scripts/video/narration-${script.roomId}.json`;
  const narration = existsSync(example) ? JSON.parse(await readFile(example, 'utf8')) : draftNarration(script);
  await writeFile(narrationFile, JSON.stringify(narration, null, 2));
}
if (!existsSync(voiceFile)) {
  const voices = await loadVoices();
  for (const c of script.cast) {
    if (!voices.profiles[c.voiceKey]) throw Error(`A voice profile is required for ${c.voiceKey}`);
    voices.profiles[c.voiceKey].label = `${c.seat}号 ${c.name}`;
  }
  await writeFile(voiceFile, JSON.stringify(voices, null, 2));
}
const narration = JSON.parse(await readFile(narrationFile, 'utf8'));
const voices = JSON.parse(await readFile(voiceFile, 'utf8'));
const raw = JSON.parse(await readFile(`${dataDir}/rooms/${script.roomId}.json`, 'utf8'));
const editorialContextFile = `${projectDir}/editorial-context.json`;
await writeFile(editorialContextFile, JSON.stringify({ roomId: script.roomId, presetName: script.presetName, ruleCard: script.ruleCard,
  cast: script.cast,
  facts: script.events.filter((e) => !['speech', 'wolf.chat', 'review'].includes(e.type)).map(({ sourceSeq, day, phase, type, text, data }) => ({ sourceSeq, day, phase, type, text, data })),
  playerSpeechIndex: script.chapters.flatMap((c) => c.entries.filter((e) => e.seat !== undefined).map((e) => ({ sourceSeq: e.sourceSeq, day: c.day, phase: c.phase, seat: e.seat, kind: e.data.kind ?? e.type, characters: e.text.length, opening: e.text.slice(0, 90) }))),
  review: script.events.findLast((e) => e.type === 'review')?.data,
  note: '全知制作材料。每句过程点评只能使用对应 sourceSeq 及以前的事实；opening 只是检索索引，引用玩家须再核对完整原文。' }, null, 2));
const summary = { roomId: script.roomId, preset: script.presetName, playerCount: script.cast.length, perspective: 'god',
  playerEntries: script.chapters.flatMap((c) => c.entries).filter((e) => e.seat !== undefined).length,
  sourceCharacters: script.chapters.flatMap((c) => c.entries).reduce((s, e) => s + e.text.length, 0),
  narrationFile, voiceFile, editorialContextFile, omittedJudgeEntries: Object.values(narration.edits).filter((e: any) => e.omit).length,
  cast: script.cast.map((c) => {
    const notes = raw.seats?.find((s: any) => s.seat === c.seat);
    return { seat: c.seat, name: c.name, roleName: c.roleName, style: notes?.style ?? '', persona: notes?.persona ?? '', voice: voices.profiles[c.voiceKey]?.voice, instruction: voices.profiles[c.voiceKey]?.instruction };
  }),
  judgeCues: voices.judgeCues ?? {},
  editorialState: narration.review?.status === 'reviewed' ? 'reviewed' : 'prepared-unreviewed',
  editorialReview: narration.review ?? null };
await writeFile(`${projectDir}/plan.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
