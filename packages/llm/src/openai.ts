import { toolToJsonSchema, type ToolCall, type ToolSpec } from '@werewolf/protocol';
import type { Adapter, AdapterConfig, ChatMessage, DecideRequest, DecideResult, ToolCallMessage } from './types';

/** 记住不支持 tool_choice=required、response_format 或流式输出的服务，之后直接降级。 */
const noRequired = new Set<string>();
const noJsonFormat = new Set<string>();
const noStream = new Set<string>();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
  }
}
class TimeoutError extends Error {}
class StreamUnsupported extends Error {}

export function chatUrl(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

/** 错误信息进入审计和日志之前去掉任何可能的密钥。 */
export function redact(text: string, key: string | null): string {
  let t = text;
  if (key) t = t.split(key).join('***');
  return t.replace(/\b(sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/g, '$1***');
}

/** 等待可以被取消。取消后清掉定时器，不再进入下一次请求。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new TimeoutError('请求已取消'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TimeoutError('请求已取消'));
    };
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function post(url: string, body: unknown, config: AdapterConfig, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new TimeoutError('请求已取消');
    const timeout = AbortSignal.timeout(Math.max(1, config.timeoutSec) * 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError(res.status, `返回的不是 JSON：${text.slice(0, 200)}`);
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(800 * (attempt + 1), signal);
        continue;
      }
      throw new HttpError(res.status, text);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof TimeoutError) throw e;
      if (timeout.aborted || signal?.aborted) throw new TimeoutError(signal?.aborted ? '请求已取消' : `超过 ${config.timeoutSec} 秒没有返回`);
      if (attempt < 2) {
        await sleep(800 * (attempt + 1), signal);
        continue;
      }
      throw e;
    }
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function withNotes(result: DecideResult, msg: Record<string, unknown>): DecideResult {
  const thinking = textOf(msg.reasoning_content) || textOf(msg.reasoning) || textOf(msg.thinking);
  const reply = textOf(msg.content);
  if (thinking) result.thinking = thinking;
  if (reply) result.reply = reply;
  return result;
}

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

/** 读流式响应，把思考和正文逐段交出去，并拼回一条完整的 message。 */
async function postStream(
  url: string,
  body: Record<string, unknown>,
  config: AdapterConfig,
  signal: AbortSignal | undefined,
  onDelta: DecideRequest['onDelta'],
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const timeout = AbortSignal.timeout(Math.max(1, config.timeoutSec) * 1000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (timeout.aborted || signal?.aborted) throw new TimeoutError(signal?.aborted ? '请求已取消' : `超过 ${config.timeoutSec} 秒没有返回`);
    throw e;
  }
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && /stream/i.test(text)) throw new StreamUnsupported();
    throw new HttpError(res.status, text);
  }
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('text/event-stream')) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(res.status, `返回的不是 JSON：${text.slice(0, 200)}`);
    }
  }

  const acc = { content: '', reasoning: '', calls: new Map<number, PartialCall>() };
  const reader = res.body?.getReader();
  if (!reader) throw new HttpError(res.status, '流式响应没有正文');
  const decoder = new TextDecoder();
  let buf = '';
  const take = (line: string) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data:')) return false;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return data === '[DONE]';
    let obj: any;
    try {
      obj = JSON.parse(data);
    } catch {
      return false;
    }
    const delta = obj?.choices?.[0]?.delta ?? obj?.choices?.[0]?.message;
    if (!delta || typeof delta !== 'object') return false;
    const reasoning = textOf(delta.reasoning_content) || textOf(delta.reasoning) || textOf(delta.thinking);
    if (reasoning) {
      acc.reasoning += reasoning;
      onDelta?.({ thinking: reasoning });
    }
    const reply = textOf(delta.content);
    if (reply) {
      acc.content += reply;
      onDelta?.({ reply });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = typeof call?.index === 'number' ? call.index : 0;
        const cur = acc.calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof call?.id === 'string' && call.id) cur.id = call.id;
        if (typeof call?.function?.name === 'string') cur.name += call.function.name;
        if (typeof call?.function?.arguments === 'string') cur.arguments += call.function.arguments;
        acc.calls.set(index, cur);
      }
    }
    return false;
  };
  try {
    let finished = false;
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (take(line)) {
          finished = true;
          await reader.cancel();
          break;
        }
        nl = buf.indexOf('\n');
      }
    }
    if (!finished && buf.trim()) take(buf);
  } catch (e) {
    if (timeout.aborted || signal?.aborted) throw new TimeoutError(signal?.aborted ? '请求已取消' : `超过 ${config.timeoutSec} 秒没有返回`);
    throw e;
  }

  const calls = [...acc.calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => ({
      id: call.id || 'call_0',
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: acc.content || null,
          ...(acc.reasoning ? { reasoning_content: acc.reasoning } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
      },
    ],
  };
}

function openaiTools(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: `${t.title}：${t.description}`, parameters: toolToJsonSchema(t) },
  }));
}

function jsonInstruction(tools: ToolSpec[]): ChatMessage {
  const schema = tools.map((t) => ({ name: t.name, description: `${t.title}：${t.description}`, parameters: toolToJsonSchema(t) }));
  return {
    role: 'system',
    content:
      '这次不使用函数调用。只输出一个 JSON 对象，不要输出任何其他文字，格式为 {"tool": "工具名", "args": {参数}}。\n' +
      `当前可用工具：${JSON.stringify(schema)}`,
  };
}

function fail(started: number, error: string, extra: Partial<DecideResult> = {}): DecideResult {
  return { ok: false, error, toolCallIds: [], latencyMs: Date.now() - started, ...extra };
}

function checkCall(name: unknown, args: unknown, tools: ToolSpec[]): string | null {
  if (typeof name !== 'string' || !tools.some((t) => t.name === name)) {
    return `工具「${String(name)}」不在当前合法列表中，可用：${tools.map((t) => t.name).join('、')}`;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return '工具参数必须是一个 JSON 对象';
  return null;
}

function parseToolReply(started: number, msg: Record<string, unknown>, tools: ToolSpec[], raw: unknown): DecideResult {
  const list = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Record<string, any>[]) : [];
  const calls: ToolCallMessage[] = list.map((c, i) => ({
    id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`,
    type: 'function',
    function: { name: String(c.function?.name ?? ''), arguments: String(c.function?.arguments ?? '{}') },
  }));
  const assistant: ChatMessage = { role: 'assistant', content: null, ...(calls.length ? { tool_calls: calls } : {}) };
  const base = { assistant, toolCallIds: calls.map((c) => c.id), raw };
  if (!calls.length) return fail(started, '没有调用工具，必须调用且只调用一个工具', base);
  if (calls.length > 1) return fail(started, `一次调用了 ${calls.length} 个工具，每次只能调用一个`, base);
  let args: unknown;
  try {
    args = JSON.parse(calls[0].function.arguments || '{}');
  } catch {
    return fail(started, '工具参数不是合法的 JSON', base);
  }
  const problem = checkCall(calls[0].function.name, args, tools);
  if (problem) return fail(started, problem, base);
  const call: ToolCall = { tool: calls[0].function.name, args: args as Record<string, unknown> };
  return { ok: true, call, ...base, latencyMs: Date.now() - started };
}

function parseJsonReply(started: number, msg: Record<string, unknown>, tools: ToolSpec[], raw: unknown): DecideResult {
  const content = typeof msg.content === 'string' ? msg.content : '';
  const assistant: ChatMessage = { role: 'assistant', content };
  const base = { assistant, toolCallIds: [], raw };
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) return fail(started, '没有返回 JSON 对象', base);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content.slice(start, end + 1));
  } catch {
    return fail(started, '返回的 JSON 无法解析', base);
  }
  const args = obj.args ?? {};
  const problem = checkCall(obj.tool, args, tools);
  if (problem) return fail(started, problem, base);
  return { ok: true, call: { tool: obj.tool as string, args: args as Record<string, unknown> }, ...base, latencyMs: Date.now() - started };
}

export const openaiAdapter: Adapter = {
  async decide(req: DecideRequest): Promise<DecideResult> {
    const started = Date.now();
    const { config, tools } = req;
    if (!config.baseUrl.trim() || !config.model.trim()) return fail(started, '座位没有配置接口地址或模型名');
    const url = chatUrl(config.baseUrl);
    const memo = `${url}|${config.model}`;
    const json = config.toolMode === 'json';

    const body = (): Record<string, unknown> => {
      const b: Record<string, unknown> = { model: config.model, temperature: config.temperature };
      if (json) {
        b.messages = [...req.messages, jsonInstruction(tools)];
        if (!noJsonFormat.has(memo)) b.response_format = { type: 'json_object' };
      } else {
        b.messages = req.messages;
        b.tools = openaiTools(tools);
        b.tool_choice = noRequired.has(memo) ? 'auto' : 'required';
      }
      return b;
    };

    const load = async (allowStream: boolean) => {
      const payload = body();
      if (allowStream && req.stream && !noStream.has(memo)) {
        try {
          return await postStream(url, payload, config, req.signal, req.onDelta);
        } catch (e) {
          if (e instanceof StreamUnsupported) {
            noStream.add(memo);
            return post(url, payload, config, req.signal);
          }
          throw e;
        }
      }
      return post(url, payload, config, req.signal);
    };

    let data: any;
    try {
      try {
        data = await load(true);
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 400) throw e;
        if (!json && /tool_choice/i.test(e.body) && !noRequired.has(memo)) noRequired.add(memo);
        else if (json && /response_format|json_object/i.test(e.body) && !noJsonFormat.has(memo)) noJsonFormat.add(memo);
        else throw e;
        data = await load(false);
      }
    } catch (e) {
      if (e instanceof TimeoutError) return fail(started, e.message, { fatal: true });
      if (e instanceof HttpError) return fail(started, redact(`接口返回 ${e.status}：${e.body.slice(0, 300)}`, config.apiKey), { fatal: true });
      return fail(started, redact(`请求失败：${(e as Error).message}`, config.apiKey), { fatal: true });
    }

    const msg = data?.choices?.[0]?.message;
    if (!msg || typeof msg !== 'object') return fail(started, '返回里没有 choices[0].message', { raw: data });
    const parsed = json ? parseJsonReply(started, msg, tools, data) : parseToolReply(started, msg, tools, data);
    return withNotes(parsed, msg);
  },
};

const PING: ToolSpec = {
  name: 'ping',
  title: '连通性测试',
  description: '确认接口可用。',
  params: [{ kind: 'boolean', name: 'ok', label: '固定为 true' }],
};

/** 连通性测试：不携带任何对局信息，只确认地址、密钥和模型能返回一次工具调用。 */
export async function testConnection(config: AdapterConfig): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const r = await openaiAdapter.decide({
    seat: 0,
    messages: [
      { role: 'system', content: '这是一次接口连通性测试。' },
      { role: 'user', content: '请调用 ping 工具，参数 ok 设为 true。' },
    ],
    tools: [PING],
    config: { ...config, timeoutSec: Math.min(config.timeoutSec, 30) },
  });
  return r.ok
    ? { ok: true, message: `连接成功，模型返回了一次 ${r.call!.tool} 调用。`, latencyMs: r.latencyMs }
    : { ok: false, message: r.error ?? '未知错误', latencyMs: r.latencyMs };
}
