import type { ApiProtocol } from '@werewolf/protocol';

export interface ReplayWireRequest { endpoint: string; body: Record<string, unknown>; binding: string; timeoutSec: number }
export interface ReplayOutput {
  status: 'completed' | 'failed';
  failureKind?: 'http' | 'network' | 'timeout' | 'invalid_response';
  text: string;
  calls: { id: string; name: string; arguments: string }[];
  latencyMs: number;
  httpAttempts: number;
  httpStatus?: number;
  usage?: Record<string, number>;
  responseModel?: string;
  error?: string;
}

type Call = ReplayOutput['calls'][number];
type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const truncated = (reason: unknown) => reason === 'length' || reason === 'max_tokens' || reason === 'model_context_window_exceeded' || reason === 'content_filter';

export async function replayRequest(request: ReplayWireRequest, protocol: ApiProtocol, apiKey: string | null): Promise<ReplayOutput> {
  const start = Date.now();
  const result: ReplayOutput = { status: 'failed', text: '', calls: [], latencyMs: 0, httpAttempts: 0 };
  const finish = (kind?: ReplayOutput['failureKind']): ReplayOutput => {
    result.latencyMs = Date.now() - start;
    if (kind) { result.failureKind = kind; result.error = ({ http: 'HTTP request failed', network: 'Network request failed', timeout: 'Request timed out', invalid_response: 'Invalid or incomplete response' })[kind]; }
    else result.status = 'completed';
    return result;
  };
  let url: URL;
  try { url = new URL(request.endpoint); } catch { return finish('invalid_response'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(request.endpoint) || /^[a-z]+:\/\/[^/]*@/i.test(request.endpoint) || !Number.isFinite(request.timeoutSec) || request.timeoutSec <= 0 || request.timeoutSec > 600) return finish('invalid_response');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutSec * 1000);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (protocol === 'anthropic_messages') { headers['anthropic-version'] = '2023-06-01'; if (apiKey) headers['x-api-key'] = apiKey; }
  else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const calls = new Map<number, Call>();
  const updateUsage = (value: unknown) => {
    const usage = Object.fromEntries(Object.entries(object(value)).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>;
    if (Object.keys(usage).length) result.usage = { ...result.usage, ...usage };
  };
  const model = (value: unknown) => { if (typeof value === 'string') result.responseModel = value; };
  const parseResponseItems = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const i = object(item);
      if (i.type === 'message' && Array.isArray(i.content)) for (const part of i.content) if (part?.type === 'output_text') result.text += string(part.text);
      if (i.type === 'function_call') result.calls.push({ id: string(i.call_id), name: string(i.name), arguments: string(i.arguments) });
    }
  };
  let ended = false;
  let bad = false;
  let stopReason: unknown;
  let chatMessageSeen = false;
  let chatFinished = false;
  const event = (data: string) => {
    if (data === '[DONE]') { if (protocol === 'chat_completions') ended = true; return; }
    let e: ObjectValue;
    try { e = object(JSON.parse(data)); } catch { bad = true; return; }
    if (e.type === 'error' || e.type === 'response.failed' || e.type === 'response.incomplete') bad = true;
    if (protocol === 'chat_completions') {
      if (e.error) bad = true;
      model(e.model); updateUsage(e.usage);
      for (const c of Array.isArray(e.choices) ? e.choices : []) {
        const d = object(c.delta); result.text += string(d.content);
        if (d.role === 'assistant' || typeof d.content === 'string' || Array.isArray(d.tool_calls)) chatMessageSeen = true;
        for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
          const index = typeof t.index === 'number' ? t.index : 0;
          const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof t.id === 'string') call.id = t.id;
          call.name += string(t.function?.name); call.arguments += string(t.function?.arguments); calls.set(index, call);
        }
        if (c.finish_reason != null) { ended = true; chatFinished = true; if (truncated(c.finish_reason)) bad = true; }
      }
    } else if (protocol === 'responses') {
      if (e.type === 'response.output_text.delta') result.text += string(e.delta);
      if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') calls.set(e.output_index, { id: string(e.item.call_id), name: string(e.item.name), arguments: string(e.item.arguments) });
      if (e.type === 'response.function_call_arguments.delta') { const call = calls.get(e.output_index) ?? { id: '', name: '', arguments: '' }; call.arguments += string(e.delta); calls.set(e.output_index, call); }
      if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') calls.set(e.output_index, { id: string(e.item.call_id), name: string(e.item.name), arguments: string(e.item.arguments) });
      if (e.type === 'response.completed') {
        ended = true; const response = object(e.response); model(response.model); updateUsage(response.usage);
        if (response.status && response.status !== 'completed') bad = true;
        if (Array.isArray(response.output)) { result.text = ''; calls.clear(); result.calls = []; parseResponseItems(response.output); }
      }
    } else {
      if (e.type === 'message_start') { model(e.message?.model); updateUsage(e.message?.usage); }
      if (e.type === 'content_block_start') {
        const b = object(e.content_block);
        if (b.type === 'text') result.text += string(b.text);
        if (b.type === 'tool_use') calls.set(e.index, { id: string(b.id), name: string(b.name), arguments: b.input && Object.keys(object(b.input)).length ? JSON.stringify(b.input) : '' });
      }
      if (e.type === 'content_block_delta') {
        if (e.delta?.type === 'text_delta') result.text += string(e.delta.text);
        if (e.delta?.type === 'input_json_delta') { const call = calls.get(e.index); if (call) call.arguments += string(e.delta.partial_json); else bad = true; }
      }
      if (e.type === 'message_delta') { stopReason = e.delta?.stop_reason; updateUsage(e.usage); }
      if (e.type === 'message_stop') ended = true;
    }
  };
  try {
    const body = JSON.stringify(request.body);
    result.httpAttempts = 1;
    const response = await fetch(request.endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
    result.httpStatus = response.status;
    if (!response.ok) return finish('http');
    if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      if (!response.body) return finish('invalid_response');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let lines: string[] = [];
      const line = (value: string) => {
        if (!value) { if (lines.length) event(lines.join('\n')); lines = []; }
        else if (value === 'data' || value.startsWith('data:')) { let field = value.slice(5); if (field.startsWith(' ')) field = field.slice(1); lines.push(field); }
      };
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        let match: RegExpExecArray | null;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          if (match[0] === '\r' && match.index === buffer.length - 1 && !chunk.done) break;
          line(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
        }
        if (chunk.done) break;
      }
      // A final event without its blank-line delimiter was not fully delivered.
      if (buffer || lines.length) bad = true;
      result.calls.push(...[...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c));
      if (protocol === 'anthropic_messages' && (!stopReason || truncated(stopReason))) bad = true;
      if (protocol === 'chat_completions' && (!chatMessageSeen || !chatFinished)) bad = true;
      if (!ended || bad) return finish('invalid_response');
    } else {
      let data: ObjectValue;
      try { data = object(await response.json()); } catch { return finish('invalid_response'); }
      model(data.model); updateUsage(data.usage);
      if (protocol === 'chat_completions') {
        const choice = Array.isArray(data.choices) ? data.choices[0] : undefined; const message = object(choice?.message);
        result.text = string(message.content);
        for (const c of Array.isArray(message.tool_calls) ? message.tool_calls : []) result.calls.push({ id: string(c.id), name: string(c.function?.name), arguments: string(c.function?.arguments) });
        if (!choice || !choice.message || typeof choice.message !== 'object' || !choice.finish_reason || truncated(choice.finish_reason)) bad = true;
      } else if (protocol === 'responses') {
        parseResponseItems(data.output); if (data.status !== 'completed' || !Array.isArray(data.output)) bad = true;
      } else {
        if (!Array.isArray(data.content) || !data.stop_reason || truncated(data.stop_reason)) bad = true;
        for (const b of Array.isArray(data.content) ? data.content : []) {
          if (b.type === 'text') result.text += string(b.text);
          if (b.type === 'tool_use') result.calls.push({ id: string(b.id), name: string(b.name), arguments: JSON.stringify(b.input ?? {}) });
        }
      }
      if (bad) return finish('invalid_response');
    }
    return finish();
  } catch {
    result.calls.push(...[...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c));
    return finish(timedOut ? 'timeout' : 'network');
  } finally { clearTimeout(timer); }
}

