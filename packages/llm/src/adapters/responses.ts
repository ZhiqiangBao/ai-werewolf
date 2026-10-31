import { apiUrl, isDashscopeEndpoint, thinkingParameters, toolToJsonSchema } from '@werewolf/protocol';
import { nativeItems, protocolBinding } from '../transcript';
import { failure, HttpError, post, runRequest } from '../transport';
import { jsonInstruction, parseAssistant, parseJson, tokenUsage } from '../result';
import type { Adapter, AdapterConfig, TranscriptMessage } from '../types';

export function responsesInput(messages: TranscriptMessage[], config: AdapterConfig): Record<string, any>[] {
  const binding = protocolBinding({ ...config, apiProtocol: 'responses' });
  const ids = new Map<string, string>();
  return messages.flatMap((m, index) => {
    const native = nativeItems(m, 'responses', binding);
    if (native) { for (const c of m.role === 'assistant' ? m.calls ?? [] : []) ids.set(c.id, c.id); return native; }
    if (m.role === 'tool') return [{ type: 'function_call_output', call_id: ids.get(m.callId) ?? m.callId, output: m.content }];
    if (m.role === 'assistant') return [
      ...(m.content ? [{ role: 'assistant', content: m.content }] : []),
      ...(m.calls ?? []).map((c, callIndex) => { const id = `history_${index}_${callIndex}`; ids.set(c.id, id); return { type: 'function_call', call_id: id, name: c.name, arguments: c.arguments }; }),
    ];
    return [{ role: m.role, content: m.role === 'user' && m.name ? `[${m.name}]\n${m.content}` : m.content }];
  });
}

export const responsesAdapter: Adapter = {
  decide(req) {
    return runRequest(req, async (signal, started, onDelta) => {
      const config = { ...req.config, apiProtocol: 'responses' as const };
      const json = config.toolMode === 'json' && req.toolChoice !== 'auto';
      const messages: TranscriptMessage[] = json ? [...req.messages, { role: 'user', content: jsonInstruction(req.tools) }] : req.messages;
      const body: Record<string, unknown> = {
        model: config.model, input: responsesInput(messages, config), store: false,
        include: ['reasoning.encrypted_content'],
        ...thinkingParameters(config.baseUrl, config.model, config.thinkingMode, 'responses'),
        max_output_tokens: config.maxOutputTokens ?? 32768,
        ...(req.cacheKey ? { prompt_cache_key: `${req.cacheKey}:${protocolBinding(config).slice(0, 16)}` } : {}),
        ...(json ? { text: { format: { type: 'json_object' } } } : {
          tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: `${t.title}：${t.description}`, parameters: toolToJsonSchema(t), strict: true })),
          tool_choice: req.toolChoice === 'auto' || (isDashscopeEndpoint(config.baseUrl) && req.tools.length > 1) ? 'auto' : 'required', parallel_tool_calls: false,
        }),
        ...(req.stream ? { stream: true } : {}),
      };
      // 推理型号不一定接受 temperature；只在未启用其原生推理参数时传递。
      if (!/^(?:gpt-[56]|o[134])(?:[.-]|$)/i.test(config.model)) body.temperature = config.temperature;
      let completed: any;
      const items = new Map<number, Record<string, any>>();
      const result = await post(apiUrl(config.baseUrl, 'responses'), body, config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}, signal, (e) => {
        if (e.type === 'error' || e.type === 'response.failed') throw new HttpError(200, JSON.stringify(e.error ?? e.response?.error ?? e));
        if (e.type === 'response.output_text.delta') onDelta({ reply: e.delta ?? '' });
        if (e.type === 'response.reasoning_summary_text.delta' || e.type === 'response.reasoning_text.delta') onDelta({ thinking: e.delta ?? '' });
        if (e.type === 'response.output_item.added' || e.type === 'response.output_item.done') items.set(e.output_index, e.item);
        if (e.type === 'response.completed' || e.type === 'response.incomplete') completed = e.response;
      });
      const data = result ?? completed;
      if (!data || data.status === 'failed' || data.status === 'incomplete' || (data.status && data.status !== 'completed')) throw new HttpError(200, `Responses 回复未完成：${data?.incomplete_details?.reason ?? data?.status ?? '流式连接提前结束'}`);
      const output = Array.isArray(data.output) ? data.output : [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      if (!output.length) return failure(started, 'Responses 没有返回 output items', { raw: data });
      const reply = output.filter((i: any) => i.type === 'message').flatMap((i: any) => i.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
      const thinking = output.filter((i: any) => i.type === 'reasoning').flatMap((i: any) => i.summary ?? []).map((s: any) => s.text ?? '').join('');
      const assistant = { role: 'assistant' as const, content: json || req.toolChoice === 'auto' ? reply || null : null,
        calls: output.filter((i: any) => i.type === 'function_call').map((i: any) => ({ id: i.call_id, name: i.name, arguments: i.arguments })),
        native: { protocol: 'responses' as const, binding: protocolBinding(config), items: output },
      };
      return { ...(json ? parseJson(started, assistant, req.tools, data) : parseAssistant(started, assistant, req.tools, data, req.toolChoice === 'auto')),
        reply: reply || undefined, thinking: thinking || undefined, usage: tokenUsage(data.usage, 'responses'),
      };
    });
  },
};
