import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { projectDir, loadScript, loadVoices, dataDir } from './project';
import { draftNarration } from './narration';
import { syncPublishCopy } from './publish-copy';
import { applyCharacterVoices, themeVoiceBindings } from './character-voices';
import { artManifest, bindTheme } from './avatar-theme';
import { projectTtsModel, selectVoiceCatalogModel } from './tts-config';
import { applyCharacterDelivery } from './character-delivery';
import { join } from 'node:path';
const script = await loadScript(); await mkdir(projectDir, { recursive: true });
const theme = await bindTheme(projectDir, join(dataDir, 'rooms', `${script.roomId}.json`), process.env.VIDEO_AVATAR_STYLE, true);
const narrationFile = process.env.VIDEO_NARRATION_FILE || `${projectDir}/narration.json`;
const voiceFile = process.env.VIDEO_VOICES_FILE || `${projectDir}/voices.json`;
const requestedTtsModel = process.env.VIDEO_TTS_MODEL;
const usesQwen = !process.env.VIDEO_TTS_PROVIDER || process.env.VIDEO_TTS_PROVIDER === 'qwen-token-plan';
if (!existsSync(narrationFile)) {
  const example = `scripts/video/narration-${script.roomId}.json`;
  const narration = script.perspective === 'god' && existsSync(example) ? JSON.parse(await readFile(example, 'utf8')) : draftNarration(script);
  await writeFile(narrationFile, JSON.stringify(narration, null, 2));
}
if (!existsSync(voiceFile)) {
  const base = applyCharacterDelivery(applyCharacterVoices(await loadVoices(), script.cast, theme), script.cast, theme);
  const voices = usesQwen ? selectVoiceCatalogModel(base, projectTtsModel(requestedTtsModel)) : base;
  if (usesQwen) voices.characterVoiceDesign = 'portrait-v1';
  await writeFile(voiceFile, JSON.stringify(voices, null, 2));
} else {
  const current = JSON.parse(await readFile(voiceFile, 'utf8'));
  const originalCurrent = JSON.stringify(current);
  const enrollmentFile = join(projectDir, 'voice-enrollment.json');
  if (requestedTtsModel && existsSync(enrollmentFile)) {
    const enrollment = JSON.parse(await readFile(enrollmentFile, 'utf8')) as { model?: string; voices?: Record<string, { voice?: string; status?: string }>; models?: Record<string, Record<string, { voice?: string; status?: string }>> };
    const enrolled = enrollment.models?.[requestedTtsModel] ?? (enrollment.model === requestedTtsModel ? enrollment.voices : undefined);
    if (enrolled) {
      for (const [key, entry] of Object.entries(enrolled)) {
        if (entry.status === 'OK' && entry.voice && current.profiles?.[key]) {
          current.modelVoiceBindings ??= {};
          current.modelVoiceBindings[requestedTtsModel] ??= {};
          current.modelVoiceBindings[requestedTtsModel][key] = entry.voice;
          if (requestedTtsModel === 'qwen-audio-3.1-tts-flash') {
            current.flashVoiceBindings ??= {};
            current.flashVoiceBindings[key] = entry.voice;
          }
          current.profiles[key] = { ...current.profiles[key], voice: entry.voice };
        }
      }
    }
  }
  const expectedBindings = themeVoiceBindings(theme, script.cast);
  const bindingsMatch = current.theme === theme && JSON.stringify(current.themeVoiceBindings ?? {}) === JSON.stringify(expectedBindings);
  const themed = bindingsMatch ? current : applyCharacterVoices(current, script.cast, theme);
  const voices = requestedTtsModel ? selectVoiceCatalogModel(themed, requestedTtsModel) : themed;
  if (JSON.stringify(voices) !== originalCurrent) await writeFile(voiceFile, JSON.stringify(voices, null, 2));
}
const narration = JSON.parse(await readFile(narrationFile, 'utf8'));
const voices = JSON.parse(await readFile(voiceFile, 'utf8'));
const artManifestFile = join(projectDir, 'art-manifest.json');
await writeFile(artManifestFile, JSON.stringify(artManifest(theme, script.cast, voices), null, 2));
const raw = script.perspective === 'god' ? JSON.parse(await readFile(`${dataDir}/rooms/${script.roomId}.json`, 'utf8')) : null;
if (raw) await syncPublishCopy(projectDir, raw, script);
const editorialContextFile = `${projectDir}/editorial-context.json`;
await writeFile(editorialContextFile, JSON.stringify({ roomId: script.roomId, presetName: script.presetName, ruleCard: script.ruleCard,
  cast: script.cast,
  facts: script.events.filter((e) => !['speech', 'wolf.chat', 'review'].includes(e.type)).map(({ sourceSeq, day, phase, type, text, data }) => ({ sourceSeq, day, phase, type, text, data })),
  playerSpeechIndex: script.chapters.flatMap((c) => c.entries.filter((e) => e.seat !== undefined).map((e) => ({ sourceSeq: e.sourceSeq, day: c.day, phase: c.phase, seat: e.seat, kind: e.data.kind ?? e.type, characters: e.text.length, opening: e.text.slice(0, 90) }))),
  review: script.events.findLast((e) => e.type === 'review')?.data,
  note: script.perspective === 'player' ? '仅该座位可见事实；不使用全知素材或自由解说。' : '全知制作材料。每句过程点评只能使用对应 sourceSeq 及以前的事实；opening 只是检索索引，引用玩家须再核对完整原文。' }, null, 2));
const summary = { roomId: script.roomId, preset: script.presetName, playerCount: script.cast.length, perspective: script.perspective, playerSeat: script.playerSeat,
  playerEntries: script.chapters.flatMap((c) => c.entries).filter((e) => e.seat !== undefined).length,
  sourceCharacters: script.chapters.flatMap((c) => c.entries).reduce((s, e) => s + e.text.length, 0),
  theme, artManifestFile, narrationFile, voiceFile, editorialContextFile, omittedJudgeEntries: Object.values(narration?.edits ?? {}).filter((e: any) => e?.omit).length,
  cast: script.cast.map((c) => {
    const notes = raw?.seats?.find((s: any) => s.seat === c.seat);
    return { seat: c.seat, name: c.name, roleName: c.roleName, controller: notes?.controller ?? 'unknown', model: notes?.controller === 'human' ? null : notes?.model ?? null,
      style: notes?.style ?? '', persona: notes?.persona ?? '', voice: voices?.profiles?.[c.voiceKey]?.voice, instruction: voices?.profiles?.[c.voiceKey]?.instruction };
  }),
  judgeCues: voices?.judgeCues ?? {},
  editorialState: narration?.review?.status === 'reviewed' ? 'reviewed' : 'prepared-unreviewed',
  editorialReview: narration?.review ?? null };
await writeFile(`${projectDir}/plan.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
