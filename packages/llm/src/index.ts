import type { AdapterKind } from '@werewolf/protocol';
import { mockAdapter } from './mock';
import { openaiAdapter } from './openai';
import type { Adapter } from './types';

export * from './types';
export { buildMessages, feedbackMessages } from './prompt';
export { mockAdapter, mockDecision } from './mock';
export { openaiAdapter, testConnection, chatUrl, redact } from './openai';
export { STYLES, DEFAULT_STYLE, styleText, type Style } from './styles';

export function getAdapter(kind: AdapterKind): Adapter {
  return kind === 'openai_compatible' ? openaiAdapter : mockAdapter;
}
