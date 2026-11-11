import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { characterVoices } from './character-voices';
import { synthesizeQwen } from './qwen';
import { characterVoiceDirection } from './character-delivery';
import { environmentForTtsModel, projectTtsModel, resolveTtsModelConfig, selectVoiceCatalogModel } from './tts-config';
import { projectQwenTokenPlanKey } from '../../packages/session/src/project-models';
import type { VoiceCatalog } from './project';

const args = new Map(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf('=');
  return [arg.slice(0, index < 0 ? undefined : index), index < 0 ? 'true' : arg.slice(index + 1)];
}));
const project = resolve(args.get('--project-dir') || process.env.VIDEO_PROJECT_DIR || 'data/video/current');
const output = resolve(args.get('--reference-dir') || join(project, 'voice-references'));
const theme = args.get('--theme') || (JSON.parse(await readFile(join(project, 'avatar-theme.json'), 'utf8')) as { theme: string }).theme;
const voicesFile = resolve(process.env.VIDEO_VOICES_FILE || join(project, 'voices.json'));
const savedVoices = existsSync(voicesFile) ? JSON.parse(await readFile(voicesFile, 'utf8')) as VoiceCatalog : undefined;
if (savedVoices?.theme && savedVoices.theme !== theme) throw Error('Reference voices belong to another portrait theme');
const model = projectTtsModel(args.get('--model'), savedVoices);
const route = resolveTtsModelConfig(model);
Object.assign(process.env, environmentForTtsModel(model));
const endpoint = args.get('--endpoint') || route.endpoint;
const explicit = args.has('--endpoint') || args.has('--api-key-env') || route.endpoint !== 'https://token-plan.maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer';
const apiKey = process.env[args.get('--api-key-env') || route.apiKeyEnv!] || (!explicit ? projectQwenTokenPlanKey() : undefined);
const force = args.has('--force');
if (!apiKey) throw Error('Missing reference synthesis API key');
const characters = characterVoices[theme as keyof typeof characterVoices];
if (!characters) throw Error(`Unsupported avatar theme ${theme}`);
const catalog = selectVoiceCatalogModel(savedVoices ?? { model, theme, profiles: Object.fromEntries(characters.map((character, index) => [`seat-${index + 1}`, {
  voice: `qwen-audio-3.0-tts-plus-${character.voice}`, label: `seat-${index + 1}`, rate: characterVoiceDirection(theme, index + 1).rate, instruction: characterVoiceDirection(theme, index + 1).instruction,
}])) }, model);
const referenceText = args.get('--text') || '三号，你刚才说得倒是笃定。可这前后两句话，分明对不上。我想听你解释清楚，再决定这一票投给谁。';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
const manifestFile = join(output, 'manifest.json');
const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, any> : { theme, model, references: {} };
manifest.theme = theme; manifest.model = model; manifest.references ??= {};
for (let seat = 1; seat <= characters.length; seat++) {
  const file = join(output, `seat-${seat}.wav`), profile = catalog.profiles[`seat-${seat}`], voice = profile.voice;
  const requestKey = digest(Buffer.from(JSON.stringify({ model, endpoint, text: referenceText, profile })));
  const previous = manifest.references[`seat-${seat}`];
  if (!force && previous?.requestKey === requestKey && existsSync(file)) {
    const bytes = await readFile(file);
    if (bytes.length === previous.bytes && digest(bytes) === previous.sha256) continue;
  }
  // Keep the last successful reference intact until its replacement is complete.
  const staging = await mkdtemp(join(output, '.reference-')), stagedFile = join(staging, 'audio.wav');
  let meta;
  try {
    meta = await synthesizeQwen(referenceText, profile, model, stagedFile, { force: true, ...(explicit ? { endpoint, apiKey } : {}) });
    await rename(stagedFile, file);
    await rename(stagedFile + '.json', file + '.json');
  } finally {
    for (const suffix of ['', '.json', '.partial']) await unlink(stagedFile + suffix).catch(() => undefined);
    await rmdir(staging);
  }
  const bytes = await readFile(file);
  manifest.references[`seat-${seat}`] = { sourceVoice: voice, targetModel: model, endpoint, text: referenceText, rate: profile.rate, instruction: profile.instruction, requestKey, sha256: digest(bytes), bytes: meta.bytes, file };
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ seat, sourceVoice: voice, file }));
}
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ complete: true, theme, model, referenceDir: output }));
