import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadScript, loadVoices, buildClips, projectDir, type Script } from './project';
import { synthesizeSpeech } from './tts';
import { editScript } from './editorial';
import { assertPlayerSources } from './integrity';

const prepared = process.argv.includes('--prepared-clips');
const source: Script = prepared ? JSON.parse(await readFile(`${projectDir}/source.json`, 'utf8')) : await loadScript();
const script: Script = prepared ? JSON.parse(await readFile(`${projectDir}/script.json`, 'utf8')) : await editScript(source);
const voices = prepared ? JSON.parse(await readFile(`${projectDir}/voices.json`, 'utf8')) : await loadVoices();
const clips = prepared ? JSON.parse(await readFile(`${projectDir}/clips.json`, 'utf8')) as ReturnType<typeof buildClips> : buildClips(script);
assertPlayerSources(source, script, clips);
await mkdir(projectDir, { recursive: true });
await writeFile(`${projectDir}/script.json`, JSON.stringify(script, null, 2));
await writeFile(`${projectDir}/source.json`, JSON.stringify(source, null, 2));
await writeFile(`${projectDir}/voices.json`, JSON.stringify(voices, null, 2));
await writeFile(`${projectDir}/clips.json`, JSON.stringify(clips, null, 2));
if (process.argv.includes('--plan-only')) {
  console.log(JSON.stringify({ roomId: script.roomId, clips: clips.length, characters: clips.reduce((s, c) => s + c.spokenText.length, 0),
    originalPlayerEntries: source.chapters.flatMap((c) => c.entries).filter((e) => e.seat !== undefined).length,
    hostingChoices: clips.filter((c) => c.type === 'hosting.choice').length, planOnly: true }));
  process.exit(0);
}
let cursor = 0, complete = 0;
const fatal = (reason: string) => /401|403|429|key is unavailable|quota|insufficient|billing/i.test(reason);
const errors: { id: string; reason: string }[] = [];
console.log(JSON.stringify({ roomId: script.roomId, sourceEntries: script.chapters.reduce((s, c) => s + c.entries.length, 0), clips: clips.length, characters: clips.reduce((s, c) => s + c.spokenText.length, 0), model: voices.model }));
async function worker() {
  while (cursor < clips.length) {
    if (errors.some((e) => fatal(e.reason))) break;
    const clip = clips[cursor++];
    const profile = voices.profiles[clip.voiceKey];
    if (!profile) throw Error(`No voice for ${clip.voiceKey}`);
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        const start = Date.now();
        const meta = await synthesizeSpeech(clip.spokenText, profile, voices.model, clip.audioFile);
        complete++; done = true;
        console.log(JSON.stringify({ complete, total: clips.length, clip: clip.id, voice: clip.voiceKey, seconds: Math.round((Date.now() - start) / 1000), bytes: meta.bytes, words: meta.sentences.reduce((s, x) => s + x.words.length, 0) }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown synthesis error';
        console.log(JSON.stringify({ clip: clip.id, attempt: attempt + 1, error: reason }));
        if (attempt === 2 || fatal(reason)) { errors.push({ id: clip.id, reason }); break; }
        await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
      }
    }
    if (errors.some((e) => fatal(e.reason))) break;
  }
}
await Promise.all([worker(), worker(), worker()]);
await writeFile(`${projectDir}/synthesis-status.json`, JSON.stringify({ complete, total: clips.length, errors }, null, 2));
if (errors.length) process.exitCode = 1;
