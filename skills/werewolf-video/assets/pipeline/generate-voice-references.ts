import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { characterVoices } from './character-voices';
import { synthesizeQwen } from './qwen';

const args = new Map(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf('=');
  return [arg.slice(0, index < 0 ? undefined : index), index < 0 ? 'true' : arg.slice(index + 1)];
}));
const project = resolve(args.get('--project-dir') || process.env.VIDEO_PROJECT_DIR || 'data/video/current');
const output = resolve(args.get('--reference-dir') || join(project, 'voice-references'));
const theme = args.get('--theme') || (JSON.parse(await readFile(join(project, 'avatar-theme.json'), 'utf8')) as { theme: string }).theme;
const model = args.get('--model') || 'qwen-audio-3.0-tts-plus';
const endpoint = args.get('--endpoint') || 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer';
const apiKey = process.env[args.get('--api-key-env') || 'DASHSCOPE_API_KEY'];
const force = args.has('--force');
if (!apiKey) throw Error('Missing reference synthesis API key');
const characters = characterVoices[theme as keyof typeof characterVoices];
if (!characters) throw Error(`Unsupported avatar theme ${theme}`);
const referenceText = '这段声音用于狼人杀视频人物参考。请保持自然、清晰、稳定的普通话语气，完整读完这一段。';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
const manifestFile = join(output, 'manifest.json');
const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, any> : { theme, model, references: {} };
manifest.theme = theme; manifest.model = model; manifest.references ??= {};
for (let seat = 1; seat <= characters.length; seat++) {
  const file = join(output, `seat-${seat}.wav`), voice = `qwen-audio-3.0-tts-plus-${characters[seat - 1].voice}`;
  if (!force && existsSync(file) && manifest.references[`seat-${seat}`]?.sourceVoice === voice) continue;
  const meta = await synthesizeQwen(referenceText, { voice, label: `seat-${seat}`, rate: 1, instruction: '' }, model, file, { endpoint, apiKey });
  const bytes = await readFile(file);
  manifest.references[`seat-${seat}`] = { sourceVoice: voice, targetModel: model, sha256: digest(bytes), bytes: meta.bytes, file };
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ seat, sourceVoice: voice, file }));
}
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ complete: true, theme, model, referenceDir: output }));
