import type { AdapterKind, ApiProtocol } from '@werewolf/protocol';
import { mockAdapter } from './mock';
import type { Adapter } from './types';
import { remoteAdapter } from './adapters';

export * from './types';
export { migrateTranscript, chatMessages, protocolBinding } from './transcript';
export { responsesAdapter, responsesInput } from './adapters/responses';
export { anthropicAdapter, anthropicInput } from './adapters/anthropic';
export { remoteAdapter } from './adapters';
export { buildMessages, feedbackMessages } from './prompt';
export { mockAdapter, mockDecision } from './mock';
export { openaiAdapter, testConnection, chatUrl, redact } from './openai';
export { STYLES, DEFAULT_STYLE, styleText, type Style } from './styles';

export function getAdapter(kind: AdapterKind, protocol: ApiProtocol = 'chat_completions'): Adapter {
  return kind === 'openai_compatible' ? remoteAdapter(protocol) : mockAdapter;
}
