import { createHash } from 'node:crypto';
import { apiUrl, type ApiProtocol } from '@werewolf/protocol';

export interface TranscriptCall { id: string; name: string; arguments: string }

/** 原生续接数据仅属于产生它的协议、端点、模型和凭证绑定，不作为法官文本。 */
export interface NativeTurn {
  protocol: ApiProtocol;
  binding: string;
  items: Record<string, any>[];
}

export type TranscriptMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; name?: string }
  | { role: 'assistant'; content: string | null; calls?: TranscriptCall[]; native?: NativeTurn }
  | { role: 'tool'; callId: string; content: string; isError?: boolean };

/** 只用于旧存档读取和 Chat Completions 的边界，不再作为持久化格式。 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; name?: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function migrateTranscript(messages: (TranscriptMessage | ChatMessage)[]): TranscriptMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool' && 'tool_call_id' in m) return { role: 'tool', callId: m.tool_call_id, content: m.content };
    if (m.role === 'assistant' && 'tool_calls' in m) {
      return { role: 'assistant', content: m.content, ...(m.tool_calls?.length ? { calls: m.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })) } : {}) };
    }
    return m as TranscriptMessage;
  });
}

export function chatMessages(messages: TranscriptMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.callId, content: m.content };
    if (m.role === 'assistant') return { role: 'assistant', content: m.content, ...(m.calls?.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) } : {}) };
    return m.role === 'user' ? { role: 'user', content: m.content, ...(m.name ? { name: m.name } : {}) } : { role: 'system', content: m.content };
  });
}

export function protocolBinding(config: { baseUrl: string; model: string; apiKey: string | null; apiProtocol?: ApiProtocol }): string {
  const protocol = config.apiProtocol ?? 'chat_completions';
  return createHash('sha256').update(JSON.stringify([protocol, apiUrl(config.baseUrl, protocol), config.model, config.apiKey])).digest('hex');
}

export function nativeItems(message: TranscriptMessage, protocol: ApiProtocol, binding: string): Record<string, any>[] | null {
  return message.role === 'assistant' && message.native?.protocol === protocol && message.native.binding === binding ? structuredClone(message.native.items) : null;
}
