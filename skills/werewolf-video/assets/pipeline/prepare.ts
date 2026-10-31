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
const summary = { roomId: script.roomId, preset: script.presetName, playerCount: script.cast.length, perspective: 'god',
  playerEntries: script.chapters.flatMap((c) => c.entries).filter((e) => e.seat !== undefined).length,
  sourceCharacters: script.chapters.flatMap((c) => c.entries).reduce((s, e) => s + e.text.length, 0),
  narrationFile, voiceFile, omittedJudgeEntries: Object.values(narration.edits).filter((e: any) => e.omit).length,
  cast: script.cast.map((c) => {
    const notes = raw.seats?.find((s: any) => s.seat === c.seat);
    return { seat: c.seat, name: c.name, roleName: c.roleName, style: notes?.style ?? '', persona: notes?.persona ?? '', voice: voices.profiles[c.voiceKey]?.voice, instruction: voices.profiles[c.voiceKey]?.instruction };
  }),
  editorialState: 'Prepared; agent may polish commentary without altering player quotes or game facts' };
await writeFile(`${projectDir}/plan.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
