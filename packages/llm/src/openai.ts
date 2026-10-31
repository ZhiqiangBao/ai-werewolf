import { apiUrl, thinkingParameters, toolToJsonSchema, type ToolSpec } from '@werewolf/protocol';
import { chatMessages } from './transcript';
import { HttpError, post, runRequest, failure } from './transport';
import { jsonInstruction, parseAssistant, parseJson, tokenUsage } from './result';
import type { Adapter, AdapterConfig } from './types';

export { redact } from './transport';
export const chatUrl = (baseUrl: string) => apiUrl(baseUrl, 'chat_completions');

const noRequired = new Set<string>();
const noJsonFormat = new Set<string>();
const noStream = new Set<string>();

export const openaiAdapter: Adapter = {
  decide(req) {
    return runRequest(req, async (signal, started, onDelta) => {
      const { config, tools } = req;
      if (!config.baseUrl.trim() || !config.model.trim()) return failure(started, '座位没有配置接口地址或模型名');
      const url = chatUrl(config.baseUrl);
      const memo = `${url}|${config.model}`;
      const listen = req.toolChoice === 'auto';
      const json = config.toolMode === 'json' && !listen;
      const body = () => ({
        model: config.model, temperature: config.temperature,
        ...thinkingParameters(config.baseUrl, config.model, config.thinkingMode, 'chat_completions'),
        ...(config.maxOutputTokens ? { max_completion_tokens: config.maxOutputTokens } : {}),
        messages: chatMessages(json ? [...req.messages, { role: 'system', content: jsonInstruction(tools) }] : req.messages),
        ...(json ? (!noJsonFormat.has(memo) ? { response_format: { type: 'json_object' } } : {}) : {
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: `${t.title}：${t.description}`, parameters: toolToJsonSchema(t) } })),
          tool_choice: listen || noRequired.has(memo) ? 'auto' : 'required',
        }),
      });
      const headers: Record<string, string> = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
      const load = async (stream: boolean): Promise<any> => {
        const useStream = stream && !!req.stream && !noStream.has(memo);
        const acc = { content: '', reasoning_content: '', calls: new Map<number, { id: string; name: string; arguments: string }>() };
        let usage: unknown;
        const event = (obj: any) => {
          if (obj.error) throw new HttpError(200, JSON.stringify(obj.error));
          if (obj.usage) usage = obj.usage;
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
          const result = await post(url, { ...body(), ...(useStream ? { stream: true } : {}) }, headers, signal, event);
          return result ?? { usage, choices: [{ message: { content: acc.content || null, reasoning_content: acc.reasoning_content,
            tool_calls: [...acc.calls.entries()].sort(([a], [b]) => a - b).map(([, c], i) => ({ id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments } })),
          } }] };
        } catch (error) {
          if (useStream && error instanceof HttpError && error.status === 400 && /stream/i.test(error.body) && !/tool_choice|response_format/i.test(error.body)) {
            noStream.add(memo); return load(false);
          }
          throw error;
        }
      };
      let data: any;
      try { data = await load(true); } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 400) throw error;
        if (!json && !listen && /tool_choice|grammar.*(?:compil|validation)|sandbox grammar/i.test(error.body) && !noRequired.has(memo)) noRequired.add(memo);
        else if (json && /response_format|json_object/i.test(error.body) && !noJsonFormat.has(memo)) noJsonFormat.add(memo);
        else throw error;
        data = await load(false);
      }
      const msg = data?.choices?.[0]?.message;
      if (!msg || typeof msg !== 'object') return failure(started, '返回里没有 choices[0].message', { raw: data });
      const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((c: any, i: number) => ({ id: c.id || `call_${i}`, name: String(c.function?.name ?? ''), arguments: String(c.function?.arguments ?? '{}') }));
      const assistant = { role: 'assistant' as const, content: listen || json ? msg.content || null : null, ...(calls.length ? { calls } : {}) };
      return { ...(json ? parseJson(started, assistant, tools, data) : parseAssistant(started, assistant, tools, data, listen)),
        thinking: msg.reasoning_content || msg.reasoning || msg.thinking || undefined, reply: msg.content || undefined,
        usage: tokenUsage(data.usage, 'chat_completions'),
      };
    });
  },
};

const PING: ToolSpec = { name: 'ping', title: '连通性测试', description: '仅用于接口测试；调用一次，参数填写 {"ok":true}。不产生游戏行动。', params: [{ kind: 'boolean', name: 'ok', label: '固定为 true' }] };

export async function testConnection(config: AdapterConfig): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const { remoteAdapter } = await import('./adapters');
  const result = await remoteAdapter(config.apiProtocol).decide({ seat: 0,
    messages: [{ role: 'system', content: '这是一次接口连通性测试。' }, { role: 'user', content: '请调用 ping 工具，参数 ok 设为 true。' }],
    tools: [PING], config: { ...config, timeoutSec: Math.min(config.timeoutSec, 30) },
  });
  return result.ok && result.call?.tool === 'ping' && result.call.args.ok === true
    ? { ok: true, message: '连接成功，模型返回了一次 ping 调用。', latencyMs: result.latencyMs }
    : { ok: false, message: result.error ?? '模型未按要求返回 ping({"ok":true})', latencyMs: result.latencyMs };
}
