import { gameText } from '@werewolf/protocol';
import { apiUrl, isDashscopeEndpoint, thinkingParameters, toolToJsonSchema } from '@werewolf/protocol';
import { nativeItems, protocolBinding } from '../transcript';
import { abortedOutcome, failure, HttpError, post, runRequest } from '../transport';
import { jsonInstruction, parseAssistant, parseJson, tokenUsage } from '../result';
import type { Adapter, AdapterConfig, TranscriptMessage } from '../types';
import { observeSync } from '../observation';

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
    return runRequest(req, async (signal, started, onDelta, observation) => {
      const config = { ...req.config, apiProtocol: 'responses' as const };
      const url = apiUrl(config.baseUrl, 'responses', req.projection?.locale ?? req.locale);
      const json = config.toolMode === 'json' && req.toolChoice !== 'auto';
      const request = observation?.observer.start('http_request', observation.adapter.id, { variantIndex: 0, variantReason: 'initial', features: {
        stream: !!req.stream, toolChoice: json ? 'none' : req.toolChoice === 'auto' || (isDashscopeEndpoint(config.baseUrl) && req.tools.length > 1) ? 'auto' : 'required', responseFormat: json,
      } });
      try {
      const body = observeSync(observation?.observer, request, 'request_encode', () => {
      const messages: TranscriptMessage[] = json ? [...req.messages, { role: 'user', content: jsonInstruction(req.tools, req.projection?.locale ?? req.locale) }] : req.messages;
      const body: Record<string, unknown> = {
        model: config.model, input: responsesInput(messages, config), store: false,
        include: ['reasoning.encrypted_content'],
        ...thinkingParameters(config.baseUrl, config.model, config.thinkingMode, 'responses', req.projection?.locale ?? req.locale),
        max_output_tokens: config.maxOutputTokens ?? 32768,
        ...(req.cacheKey ? { prompt_cache_key: `${req.cacheKey}:${protocolBinding(config).slice(0, 16)}` } : {}),
        ...(json ? { text: { format: { type: 'json_object' } } } : {
          tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: `${t.title}：${t.description}`, parameters: toolToJsonSchema(t, req.projection?.locale ?? req.locale), strict: true })),
          tool_choice: req.toolChoice === 'auto' || (isDashscopeEndpoint(config.baseUrl) && req.tools.length > 1) ? 'auto' : 'required', parallel_tool_calls: false,
        }),
        ...(req.stream ? { stream: true } : {}),
      };
      // 推理型号不一定接受 temperature；只在未启用其原生推理参数时传递。
      if (!/^(?:gpt-[56]|o[134])(?:[.-]|$)/i.test(config.model)) body.temperature = config.temperature;
      return body;
      });
      let completed: any;
      const items = new Map<number, Record<string, any>>();
      req.onRequest?.({ apiProtocol: 'responses', tools: structuredClone(body.tools as unknown[] ?? []), toolChoice: body.tool_choice, ...(json ? { toolInstruction: jsonInstruction(req.tools, req.projection?.locale ?? req.locale) } : {}) });
      const result = await post(url, body, config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}, signal, (e) => {
        if (e.type === 'error' || e.type === 'response.failed') throw new HttpError(200, JSON.stringify(e.error ?? e.response?.error ?? e));
        if (e.type === 'response.output_text.delta') onDelta({ reply: e.delta ?? '' });
        if (e.type === 'response.reasoning_summary_text.delta' || e.type === 'response.reasoning_text.delta') onDelta({ thinking: e.delta ?? '' });
        if (e.type === 'response.output_item.added' || e.type === 'response.output_item.done') items.set(e.output_index, e.item);
        if (e.type === 'response.completed' || e.type === 'response.incomplete') completed = e.response;
      }, req.projection?.locale ?? req.locale, observation && request ? { observer: observation.observer, request, protocol: 'responses' } : undefined);
      request?.finish('success');
      return observeSync(observation?.observer, observation?.adapter, 'parse', () => {
      const data = result ?? completed;
      if (!data || data.status === 'failed' || data.status === 'incomplete' || (data.status && data.status !== 'completed')) throw new HttpError(200, gameText(req.projection?.locale ?? req.locale, 'Responses 回复未完成：{0}', data?.incomplete_details?.reason ?? data?.status ?? gameText(req.projection?.locale ?? req.locale, '流式连接提前结束')));
      const output = Array.isArray(data.output) ? data.output : [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      if (!output.length) return failure(started, gameText(req.projection?.locale ?? req.locale, 'Responses 没有返回 output items'), { raw: data });
      const reply = output.filter((i: any) => i.type === 'message').flatMap((i: any) => i.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
      const thinking = output.filter((i: any) => i.type === 'reasoning').flatMap((i: any) => i.summary ?? []).map((s: any) => s.text ?? '').join('');
      const assistant = { role: 'assistant' as const, content: json || req.toolChoice === 'auto' ? reply || null : null,
        calls: output.filter((i: any) => i.type === 'function_call').map((i: any) => ({ id: i.call_id, name: i.name, arguments: i.arguments })),
        native: { protocol: 'responses' as const, binding: protocolBinding(config), items: output },
      };
      return { ...(json ? parseJson(started, assistant, req.tools, data, req.projection?.locale ?? req.locale) : parseAssistant(started, assistant, req.tools, data, req.toolChoice === 'auto', req.projection?.locale ?? req.locale)),
        reply: reply || undefined, thinking: thinking || undefined, usage: tokenUsage(data.usage, 'responses'),
      };
      });
      } catch (error) { request?.finish(signal.aborted ? abortedOutcome(signal) : error instanceof HttpError ? error.observationOutcome : 'network_error'); throw error; }
    });
  },
};
