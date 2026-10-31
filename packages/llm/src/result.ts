import { toolToJsonSchema, type ApiProtocol, type TokenUsage, type ToolSpec } from '@werewolf/protocol';
import { failure } from './transport';
import type { DecideResult, TranscriptMessage } from './types';

/** 解析只校验调用的结构，真实目标、阶段、资源限制由同一个游戏引擎裁定。 */
export function parseAssistant(started: number, assistant: Extract<TranscriptMessage, { role: 'assistant' }>, tools: ToolSpec[], raw: unknown, allowText: boolean): DecideResult {
  const calls = assistant.calls ?? [];
  if (calls.some((c) => typeof c.id !== 'string' || !c.id) || new Set(calls.map((c) => c.id)).size !== calls.length) {
    return failure(started, '工具调用缺少唯一调用编号，未执行', { raw, assistant: { role: 'assistant', content: assistant.content } });
  }
  const base = { assistant, toolCallIds: calls.map((c) => c.id), raw };
  if (!calls.length) return allowText ? { ok: true, ...base, latencyMs: Date.now() - started } : failure(started, '没有调用工具，必须调用且只调用一个工具', base);
  if (calls.length > 1) return failure(started, `一次调用了 ${calls.length} 个工具，每次只能调用一个`, base);
  let args: unknown;
  try { args = JSON.parse(calls[0].arguments || '{}'); } catch { return failure(started, '工具参数不是合法的 JSON', base); }
  if (!tools.some((t) => t.name === calls[0].name)) return failure(started, `工具「${calls[0].name}」不在本座位的固定工具目录中；本轮可用动作请看最新法官菜单`, base);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return failure(started, '工具参数必须是一个 JSON 对象', base);
  return { ok: true, call: { tool: calls[0].name, args: args as Record<string, unknown> }, ...base, latencyMs: Date.now() - started };
}

export function jsonInstruction(tools: ToolSpec[]): string {
  return '这次不使用函数调用。只输出一个 JSON 对象，不要输出任何其他文字，格式为 {"tool":"工具名","args":{参数}}。\n下面是本座位整局固定工具目录；当前只允许最新法官菜单中的动作和目标，无参数工具填写 {}：' + JSON.stringify(tools.map((t) => ({ name: t.name, description: `${t.title}：${t.description}`, parameters: toolToJsonSchema(t) })));
}

export function parseJson(started: number, assistant: Extract<TranscriptMessage, { role: 'assistant' }>, tools: ToolSpec[], raw: unknown): DecideResult {
  if (assistant.calls?.length) return failure(started, 'JSON 模式却返回了原生工具调用，未执行', { raw, assistant, toolCallIds: assistant.calls.map((c) => c.id) });
  const content = assistant.content ?? '';
  const from = content.indexOf('{'); const to = content.lastIndexOf('}');
  const base = { assistant, raw };
  if (from < 0 || to < from) return failure(started, '没有返回 JSON 对象', base);
  let value: any;
  try { value = JSON.parse(content.slice(from, to + 1)); } catch { return failure(started, '返回的 JSON 无法解析', base); }
  const parsed = parseAssistant(started, { role: 'assistant', content, calls: [{ id: 'json', name: String(value?.tool), arguments: JSON.stringify(value?.args ?? {}) }] }, tools, raw, false);
  return { ...parsed, assistant, toolCallIds: [] };
}

export function tokenUsage(raw: any, protocol: ApiProtocol): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  const cacheReadTokens = count(protocol === 'chat_completions' ? raw.prompt_tokens_details?.cached_tokens : protocol === 'responses' ? raw.input_tokens_details?.cached_tokens : raw.cache_read_input_tokens);
  const cacheWriteTokens = count(raw.cache_creation_input_tokens);
  return { inputTokens: count(protocol === 'chat_completions' ? raw.prompt_tokens : raw.input_tokens) + (protocol === 'anthropic_messages' ? cacheReadTokens + cacheWriteTokens : 0), outputTokens: count(protocol === 'chat_completions' ? raw.completion_tokens : raw.output_tokens), cacheReadTokens, cacheWriteTokens };
}
