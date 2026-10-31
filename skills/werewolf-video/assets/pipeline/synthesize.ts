import { mkdir, writeFile } from 'node:fs/promises';
import { loadScript, loadVoices, buildClips, projectDir } from './project';
import { synthesizeQwen } from './qwen';
import { editScript } from './editorial';

const source = await loadScript(), script = await editScript(source), voices = await loadVoices(), clips = buildClips(script);
await mkdir(projectDir, { recursive: true });
await writeFile(`${projectDir}/script.json`, JSON.stringify(script, null, 2));
await writeFile(`${projectDir}/source.json`, JSON.stringify(source, null, 2));
await writeFile(`${projectDir}/voices.json`, JSON.stringify(voices, null, 2));
await writeFile(`${projectDir}/clips.json`, JSON.stringify(clips, null, 2));
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
        const meta = await synthesizeQwen(clip.spokenText, profile, voices.model, clip.audioFile);
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
