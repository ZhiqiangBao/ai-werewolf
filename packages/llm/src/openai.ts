import { gameText } from '@werewolf/protocol';
import { apiUrl, thinkingParameters, toolToJsonSchema, type ToolSpec, type VariantReason } from '@werewolf/protocol';
import { chatMessages } from './transcript';
import { abortedOutcome, HttpError, post, runRequest, failure } from './transport';
import { jsonInstruction, parseAssistant, parseJson, tokenUsage } from './result';
import type { Adapter, AdapterConfig } from './types';
import { observeSync } from './observation';

export { redact } from './transport';
export const chatUrl = (baseUrl: string, locale?: string) => apiUrl(baseUrl, 'chat_completions', locale);

const noRequired = new Set<string>();
const noJsonFormat = new Set<string>();
const noStream = new Set<string>();

export const openaiAdapter: Adapter = {
  decide(req) {
    return runRequest(req, async (signal, started, onDelta, observation) => {
      const { config, tools } = req;
      if (!config.baseUrl.trim() || !config.model.trim()) return failure(started, gameText(req.projection?.locale ?? req.locale, '座位没有配置接口地址或模型名'));
      const url = chatUrl(config.baseUrl, req.projection?.locale ?? req.locale);
      const memo = `${url}|${config.model}`;
      const listen = req.toolChoice === 'auto';
      const json = config.toolMode === 'json' && !listen;
      const body = () => ({
        model: config.model, temperature: config.temperature,
        ...thinkingParameters(config.baseUrl, config.model, config.thinkingMode, 'chat_completions', req.projection?.locale ?? req.locale),
        ...(config.maxOutputTokens ? { max_completion_tokens: config.maxOutputTokens } : {}),
        messages: chatMessages(json ? [...req.messages, { role: 'system', content: jsonInstruction(tools, req.projection?.locale ?? req.locale) }] : req.messages),
        ...(json ? (!noJsonFormat.has(memo) ? { response_format: { type: 'json_object' } } : {}) : {
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: `${t.title}：${t.description}`, parameters: toolToJsonSchema(t, req.projection?.locale ?? req.locale) } })),
          tool_choice: listen || noRequired.has(memo) ? 'auto' : 'required',
        }),
      });
      const headers: Record<string, string> = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
      let variantIndex = 0;
      const memory = noStream.has(memo) || noRequired.has(memo) || noJsonFormat.has(memo) ? 'warm' : 'cold';
      const load = async (stream: boolean, variantReason: VariantReason): Promise<any> => {
        const useStream = stream && !!req.stream && !noStream.has(memo);
        const request = observation?.observer.start('http_request', observation.adapter.id, { variantIndex: variantIndex++, variantReason,
          features: { stream: useStream, toolChoice: json ? 'none' : listen || noRequired.has(memo) ? 'auto' : 'required', responseFormat: json && !noJsonFormat.has(memo), compatibilityMemory: memory } });
        const acc = { content: '', reasoning_content: '', calls: new Map<number, { id: string; name: string; arguments: string }>() };
        let usage: unknown;
        let finishReason: unknown;
        const event = (obj: any) => {
          if (obj.error) throw new HttpError(200, JSON.stringify(obj.error));
          if (obj.usage) usage = obj.usage;
          if (obj.choices?.[0]?.finish_reason != null) finishReason = obj.choices[0].finish_reason;
          const delta = obj.choices?.[0]?.delta ?? obj.choices?.[0]?.message;
          if (!delta) return;
          const thinking = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
          if (typeof thinking === 'string') { acc.reasoning_content += thinking; onDelta({ thinking }); }
          if (typeof delta.content === 'string') { acc.content += delta.content; onDelta({ reply: delta.content }); }
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0;
            const current = acc.calls.get(index) ?? { id: '', name: '', arguments: '' };
            if (call.id) current.id = call.id;
            current.name += call.function?.name ?? ''; current.arguments += call.function?.arguments ?? '';
            acc.calls.set(index, current);
          }
        };
        try {
          const encoded = observeSync(observation?.observer, request, 'request_encode', () => ({ ...body(), ...(useStream ? { stream: true } : {}) }));
          req.onRequest?.({ apiProtocol: 'chat_completions', tools: structuredClone('tools' in encoded ? encoded.tools ?? [] : []), ...('tool_choice' in encoded ? { toolChoice: encoded.tool_choice } : {}), ...(json ? { toolInstruction: jsonInstruction(tools, req.projection?.locale ?? req.locale) } : {}) });
          const result = await post(url, encoded, headers, signal, event, req.projection?.locale ?? req.locale, observation && request ? { observer: observation.observer, request, protocol: 'chat_completions' } : undefined);
          request?.finish('success');
          return result ?? { usage, choices: [{ finish_reason: finishReason, message: { content: acc.content || null, reasoning_content: acc.reasoning_content,
            tool_calls: [...acc.calls.entries()].sort(([a], [b]) => a - b).map(([, c], i) => ({ id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments } })),
          } }] };
        } catch (error) {
          request?.finish(signal.aborted ? abortedOutcome(signal) : error instanceof HttpError ? error.observationOutcome : 'network_error');
          if (useStream && error instanceof HttpError && error.status === 400 && /stream/i.test(error.body) && !/tool_choice|response_format/i.test(error.body)) {
            noStream.add(memo); return load(false, 'stream_unsupported');
          }
          throw error;
        }
      };
      let data: any;
      try { data = await load(true, 'initial'); } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 400) throw error;
        let reason: VariantReason;
        if (!json && !listen && /tool_choice|grammar.*(?:compil|validation)|sandbox grammar/i.test(error.body) && !noRequired.has(memo)) { noRequired.add(memo); reason = 'tool_choice_unsupported'; }
        else if (json && /response_format|json_object/i.test(error.body) && !noJsonFormat.has(memo)) { noJsonFormat.add(memo); reason = 'json_format_unsupported'; }
        else throw error;
        data = await load(false, reason);
      }
      return observeSync(observation?.observer, observation?.adapter, 'parse', () => {
      const reason = data?.choices?.[0]?.finish_reason;
      // A complete JSON argument is not proof that the provider finished the turn.
      // Accept the normal text and tool-call endings, including legacy function_call.
      if (!['stop', 'tool_calls', 'function_call'].includes(reason)) {
        throw new HttpError(200, gameText(req.projection?.locale ?? req.locale, 'Chat Completions 回复未完成：{0}', reason ?? gameText(req.projection?.locale ?? req.locale, '缺少完成状态')));
      }
      const msg = data?.choices?.[0]?.message;
      if (!msg || typeof msg !== 'object') return failure(started, gameText(req.projection?.locale ?? req.locale, '返回里没有 choices[0].message'), { raw: data });
      const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((c: any, i: number) => ({ id: c.id || `call_${i}`, name: String(c.function?.name ?? ''), arguments: String(c.function?.arguments ?? '{}') }));
      const assistant = { role: 'assistant' as const, content: listen || json ? msg.content || null : null, ...(calls.length ? { calls } : {}) };
      return { ...(json ? parseJson(started, assistant, tools, data, req.projection?.locale ?? req.locale) : parseAssistant(started, assistant, tools, data, listen, req.projection?.locale ?? req.locale)),
        thinking: msg.reasoning_content || msg.reasoning || msg.thinking || undefined, reply: msg.content || undefined,
        usage: tokenUsage(data.usage, 'chat_completions'),
      };
      });
    });
  },
};

const pingTool = (locale?: string): ToolSpec => ({ name: 'ping', title: gameText(locale, '连通性测试'), description: gameText(locale, '仅用于接口测试；调用一次，参数填写 {"ok":true}。不产生游戏行动。'), params: [{ kind: 'boolean', name: 'ok', label: gameText(locale, '固定为 true') }] });

export async function testConnection(config: AdapterConfig, signal?: AbortSignal, locale?: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const { remoteAdapter } = await import('./adapters');
  const result = await remoteAdapter(config.apiProtocol).decide({ seat: 0, locale,
    messages: [{ role: 'system', content: gameText(locale, '这是一次接口连通性测试。') }, { role: 'user', content: gameText(locale, '请调用 ping 工具，参数 ok 设为 true。') }],
    tools: [pingTool(locale)], config: { ...config, timeoutSec: Math.min(config.timeoutSec, 30) }, signal,
  });
  return result.ok && result.call?.tool === 'ping' && result.call.args.ok === true
    ? { ok: true, message: gameText(locale, '连接成功，模型返回了一次 ping 调用。'), latencyMs: result.latencyMs }
    : { ok: false, message: result.error ?? gameText(locale, '模型未按要求返回 ping({"ok":true})'), latencyMs: result.latencyMs };
}
