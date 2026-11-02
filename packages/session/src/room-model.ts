import { defaultThinkingMode } from '@werewolf/protocol';
import type { AdapterConfig } from '@werewolf/llm';
import type { SecretBox } from './secret';
import type { SeatRecord } from './store';

export function adapterConfig(s: SeatRecord, secrets: SecretBox): AdapterConfig {
  return {
    apiProtocol: s.apiProtocol ?? 'chat_completions',
    baseUrl: s.baseUrl,
    model: s.model,
    apiKey: s.apiKeyEnc ? secrets.decrypt(s.apiKeyEnc) : null,
    temperature: s.temperature,
    toolMode: s.toolMode,
    timeoutSec: s.timeoutSec,
    thinkingMode: s.thinkingMode ?? defaultThinkingMode(s.baseUrl, s.model, s.apiProtocol),
    maxOutputTokens: s.maxOutputTokens,
  };
}
