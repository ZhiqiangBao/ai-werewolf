import type { ApiProtocol } from '@werewolf/protocol';
import type { Adapter } from '../types';
import { openaiAdapter } from '../openai';
import { responsesAdapter } from './responses';
import { anthropicAdapter } from './anthropic';

const adapters: Record<ApiProtocol, Adapter> = { chat_completions: openaiAdapter, responses: responsesAdapter, anthropic_messages: anthropicAdapter };
export function remoteAdapter(protocol: ApiProtocol = 'chat_completions'): Adapter {
  const adapter = adapters[protocol];
  if (!adapter) throw new Error('未注册的模型接口协议');
  return adapter;
}
