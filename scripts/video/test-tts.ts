import { readFile } from 'node:fs/promises';
import { synthesizeQwen, type VoiceProfile } from './qwen';
const voices = JSON.parse(await readFile('scripts/video/voices.json', 'utf8')) as { model: string; profiles: Record<string, VoiceProfile> };
for (const [key, text] of [
  ['judge', '第零号试音。游戏开始。第一个夜晚，天黑请闭眼。'],
  ['seat-1', '首夜没信息，建议刀中间的六号。白天我位置靠前，可以先发言带节奏。'],
  ['seat-2', '先别急着下结论。我们应该把发言顺序和票型放在一起看，这样才有依据。'],
] as const) {
  const meta = await synthesizeQwen(text, voices.profiles[key], voices.model, `data/video/e6220f1238/voices/${key}.wav`);
  console.log(JSON.stringify({ key, voice: meta.voice, bytes: meta.bytes, sentences: meta.sentences }));
}
