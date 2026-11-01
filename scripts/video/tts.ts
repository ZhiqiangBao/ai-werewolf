import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { synthesizeQwen } from './qwen';
import type { SpeechSynthesizer } from './tts-types';

let selected: Promise<SpeechSynthesizer> | undefined;
export function loadSynthesizer(): Promise<SpeechSynthesizer> {
  selected ??= (async () => {
    const provider = process.env.VIDEO_TTS_PROVIDER || 'qwen-token-plan';
    const adapter = process.env.VIDEO_TTS_ADAPTER;
    if (provider === 'qwen-token-plan') {
      if (adapter) throw Error('Use a distinct VIDEO_TTS_PROVIDER name for an external adapter');
      return synthesizeQwen;
    }
    if (!adapter) throw Error(`TTS provider ${provider} needs VIDEO_TTS_ADAPTER; no automatic provider or billing fallback`);
    const module = await import(pathToFileURL(resolve(adapter)).href);
    if (typeof module.synthesize !== 'function') throw Error('TTS adapter must export async function synthesize(text, profile, model, output)');
    return module.synthesize as SpeechSynthesizer;
  })();
  return selected;
}
export const synthesizeSpeech: SpeechSynthesizer = async (...args) => (await loadSynthesizer())(...args);
