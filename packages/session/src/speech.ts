import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { synthesizeQwen } from '../../../scripts/video/qwen';
import { readPcm, wavHeader } from '../../../scripts/video/audio';
import type { SpeechSynthesizer, VoiceProfile } from '../../../scripts/video/tts-types';

const MODEL = 'qwen-audio-3.0-tts-plus';
const PROFILE: VoiceProfile = {
  voice: 'qwen-audio-3.0-tts-plus-longshuojizhu', label: '公开发言朗读', rate: 1.08,
  instruction: '请用普通话自然清楚地朗读给定原文，准确读出玩家号码。只读原文，不添加或改写内容。',
};

/** 复用既有 Token Plan 适配器；相同公开发言只合成一次，不接受客户端自由文本。 */
export class SpeechService {
  private readonly pending = new Map<string, Promise<Buffer>>();
  constructor(private readonly directory: string, private readonly synthesize: SpeechSynthesizer = synthesizeQwen) {}

  render(text: string): Promise<Buffer> {
    const key = createHash('sha256').update(JSON.stringify({ model: MODEL, profile: PROFILE, text })).digest('hex');
    const running = this.pending.get(key);
    if (running) return running;
    const task = (async () => {
      const output = join(this.directory, `${key}.wav`);
      await this.synthesize(text, PROFILE, MODEL, output);
      // 提供方可能返回流式长度头，按实际 PCM 修正为浏览器可寻址的 WAV。
      const pcm = await readPcm(output);
      const bytes = Buffer.alloc(pcm.samples.length * 2);
      for (let i = 0; i < pcm.samples.length; i++) bytes.writeInt16LE(pcm.samples[i], i * 2);
      return Buffer.concat([wavHeader(pcm.samples.length, pcm.sampleRate), bytes]);
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}
