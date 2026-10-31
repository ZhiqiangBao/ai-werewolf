import { apiUrl, thinkingParameters, toolToJsonSchema } from '@werewolf/protocol';
import { nativeItems, protocolBinding } from '../transcript';
import { failure, HttpError, post, runRequest } from '../transport';
import { jsonInstruction, parseAssistant, parseJson, tokenUsage } from '../result';
import type { Adapter, AdapterConfig, TranscriptMessage } from '../types';

export function anthropicInput(messages: TranscriptMessage[], config: AdapterConfig) {
  const binding = protocolBinding({ ...config, apiProtocol: 'anthropic_messages' });
  const system: Record<string, any>[] = [];
  const turns: { role: 'user' | 'assistant'; content: Record<string, any>[] }[] = [];
  const ids = new Map<string, string>();
  for (const [index, m] of messages.entries()) {
    if (m.role === 'system') { system.push({ type: 'text', text: m.content }); continue; }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content: Record<string, any>[];
    if (m.role === 'assistant') {
      const native = nativeItems(m, 'anthropic_messages', binding);
      if (native) { for (const c of m.calls ?? []) ids.set(c.id, c.id); content = native; }
      else content = [ ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...(m.calls ?? []).map((c, callIndex) => { let input: unknown; try { input = JSON.parse(c.arguments); } catch { input = {}; }
          const id = `toolu_history_${index}_${callIndex}`; ids.set(c.id, id); return { type: 'tool_use', id, name: c.name, input }; }),
      ];
    }
    else if (m.role === 'tool') content = [{ type: 'tool_result', tool_use_id: ids.get(m.callId) ?? m.callId, content: m.content, ...(m.isError ? { is_error: true } : {}) }];
    else content = [{ type: 'text', text: m.name ? `[${m.name}]\n${m.content}` : m.content }];
    if (!content.length) continue;
    const previous = turns.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else turns.push({ role, content });
  }
  // 不添加显式缓存断点；只保留稳定前缀，由提供方决定是否隐式命中。
  return { system, messages: turns };
}

export const anthropicAdapter: Adapter = {
  decide(req) {
    return runRequest(req, async (signal, started, onDelta) => {
      const config = { ...req.config, apiProtocol: 'anthropic_messages' as const };
      const json = config.toolMode === 'json' && req.toolChoice !== 'auto';
      const thinking = thinkingParameters(config.baseUrl, config.model, config.thinkingMode, 'anthropic_messages');
      const budget = (thinking.thinking as { budget_tokens?: number } | undefined)?.budget_tokens ?? 0;
      const max = config.maxOutputTokens ?? 32768;
      if (budget >= max) return failure(started, '单次输出上限必须大于思考预算，才能留出工具参数空间', { fatal: true });
      const input = anthropicInput(json ? [...req.messages, { role: 'user', content: jsonInstruction(req.tools) }] : req.messages, config);
      const body: Record<string, unknown> = { model: config.model, max_tokens: max, ...input, ...thinking, ...(req.stream ? { stream: true } : {}) };
      if (!json) {
        body.tools = req.tools.map((t) => ({ name: t.name, description: `${t.title}：${t.description}`, input_schema: toolToJsonSchema(t) }));
        // auto 同时兼容手动思考、强制思考和旁听，并避免切换 tool_choice 破坏消息缓存。
        // 正式行动仍由本地解析器要求恰好一个工具，失败按现有纠错流程处理。
        body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
      }
      const blocks = new Map<number, Record<string, any>>();
      const argumentsByIndex = new Map<number, string>();
      let message: any;
      let stopped = false;
      req.onRequest?.({ apiProtocol: 'anthropic_messages', tools: structuredClone(body.tools as unknown[] ?? []), toolChoice: body.tool_choice, ...(json ? { toolInstruction: jsonInstruction(req.tools) } : {}) });
      const result = await post(apiUrl(config.baseUrl, 'anthropic_messages'), body, {
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}), 'anthropic-version': '2023-06-01',
      }, signal, (e) => {
        if (e.type === 'error') throw new HttpError(200, JSON.stringify(e.error ?? e));
        if (e.type === 'message_start') message = { ...e.message, content: [] };
        if (e.type === 'content_block_start') blocks.set(e.index, { ...e.content_block });
        if (e.type === 'content_block_delta') {
          const block = blocks.get(e.index);
          if (!block) throw new HttpError(200, '缺少 content_block_start');
          const d = e.delta;
          if (d.type === 'text_delta') { block.text = (block.text ?? '') + d.text; onDelta({ reply: d.text }); }
          if (d.type === 'thinking_delta') { block.thinking = (block.thinking ?? '') + d.thinking; onDelta({ thinking: d.thinking }); }
          if (d.type === 'signature_delta') block.signature = (block.signature ?? '') + d.signature;
          if (d.type === 'input_json_delta') argumentsByIndex.set(e.index, (argumentsByIndex.get(e.index) ?? '') + d.partial_json);
        }
        if (e.type === 'message_delta' && message) { Object.assign(message, e.delta); message.usage = { ...message.usage, ...e.usage }; }
        if (e.type === 'message_stop') stopped = true;
      });
      if (!result && (!message || !stopped)) throw new HttpError(200, 'Anthropic 流式连接提前结束，未执行任何工具');
      const data = result ?? { ...message, content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([i, block]) => {
        if (argumentsByIndex.has(i)) { try { block.input = JSON.parse(argumentsByIndex.get(i)!); } catch { block.invalidArguments = argumentsByIndex.get(i); } }
        return block;
      }) };
      if (!Array.isArray(data.content)) return failure(started, 'Anthropic 回复缺少 content blocks', { raw: data });
      if (data.stop_reason === 'max_tokens' || data.stop_reason === 'model_context_window_exceeded') throw new HttpError(200, `Anthropic 回复被截断：${data.stop_reason}`);
      const reply = data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const mind = data.content.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking).join('');
      const assistant = { role: 'assistant' as const, content: json || req.toolChoice === 'auto' ? reply || null : null,
        calls: data.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, arguments: b.invalidArguments ?? JSON.stringify(b.input) })),
        ...(!data.content.some((b: any) => b.invalidArguments !== undefined) ? { native: { protocol: 'anthropic_messages' as const, binding: protocolBinding(config), items: data.content } } : {}),
      };
      return { ...(json ? parseJson(started, assistant, req.tools, data) : parseAssistant(started, assistant, req.tools, data, req.toolChoice === 'auto')),
        reply: reply || undefined, thinking: mind || undefined, usage: tokenUsage(data.usage, 'anthropic_messages'),
      };
    });
  },
};
