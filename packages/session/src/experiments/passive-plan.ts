import { createHash } from 'node:crypto';
import type { Expected } from './passive-validator';

export type FrozenFrames = Record<string, [string, string]>;
export type FrozenConfig = {
  run: string; protocol: 'chat-completions' | 'responses' | 'anthropic-messages';
  candidate: 'A' | 'B' | 'A+D'; rooms: 1 | 2; providers: 1 | 2;
  baseMs: number; slowMs: number; slots: 4 | 8; serverSlots?: 4 | 8; faultStatus?: 429 | 503;
  sourceHash: string; budgetGroup: 'preflight' | 'fault' | 'screen' | 'formal'; totalLimit: number; windowLimit: number;
};

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const finiteNonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Rebuild from frozen inputs, without reading the producer's expected list or trace. */
export function reconstructPlan(config: FrozenConfig, frames: FrozenFrames): Expected[] {
  if (!config || typeof config !== 'object' || typeof config.run !== 'string' || !config.run ||
      !['chat-completions', 'responses', 'anthropic-messages'].includes(config.protocol) || !['A', 'B', 'A+D'].includes(config.candidate) ||
      ![1, 2].includes(config.rooms) || ![1, 2].includes(config.providers) || config.providers > config.rooms ||
      !finiteNonnegative(config.baseMs) || !finiteNonnegative(config.slowMs) || ![4, 8].includes(config.slots) ||
      (config.serverSlots !== undefined && ![4, 8].includes(config.serverSlots)) || (config.faultStatus !== undefined && ![429, 503].includes(config.faultStatus)) ||
      !/^[a-f0-9]{64}$/.test(config.sourceHash) || !['preflight', 'fault', 'screen', 'formal'].includes(config.budgetGroup) ||
      !Number.isSafeInteger(config.totalLimit) || config.totalLimit < 1 || config.totalLimit > 150000 ||
      !Number.isSafeInteger(config.windowLimit) || config.windowLimit < 1 || config.windowLimit > 512 ||
      !frames || typeof frames !== 'object' || Array.isArray(frames) || Object.keys(frames).length !== 12) throw new Error('invalid frozen config or frames');
  const perSeat = Array.from({ length: 12 }, (_, index) => {
    const pair = frames[String(index + 1)];
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string')) throw new Error('invalid frozen frames');
    const parsed = pair.map(value => JSON.parse(value) as unknown);
    if (parsed.some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('invalid frozen frame');
    return { pair, hasAction: pair[0] !== pair[1] && !!(parsed[1] as { task?: unknown }).task };
  });
  const native = (call: string): string[] => {
    if (config.protocol === 'chat-completions') return [JSON.stringify({ role: 'assistant', tool_calls: [{ id: call, type: 'function', function: { name: 'listen', arguments: '{}' } }] }), JSON.stringify({ role: 'tool', tool_call_id: call, content: 'ok' })];
    if (config.protocol === 'responses') return [JSON.stringify({ type: 'function_call', call_id: call, name: 'listen', arguments: '{}' }), JSON.stringify({ type: 'function_call_output', call_id: call, output: 'ok' })];
    return [JSON.stringify({ type: 'thinking', thinking: 'synthetic', signature: `sig-${call}` }), JSON.stringify({ type: 'tool_use', id: call, name: 'listen', input: {} }), JSON.stringify({ type: 'tool_result', tool_use_id: call, content: 'ok' })];
  };
  const expected: Expected[] = [];
  for (const segment of ['normal', 'slow']) for (let room = 1; room <= config.rooms; room++) for (let number = 1; number <= 12; number++) {
    const seat = `${room}:${number}`; const { pair, hasAction } = perSeat[number - 1];
    for (let wave = 0; wave <= Number(hasAction); wave++) {
      const call = `${segment}/${seat}/${wave}`;
      const previous = segment === 'normal' ? [] : [`normal/${seat}/0`, ...(hasAction ? [`normal/${seat}/1`] : [])];
      if (wave === 1) previous.push(`${segment}/${seat}/0`);
      const base = { run: config.run, seat, call, projectionHash: digest(pair[wave]), history: previous.flatMap(id => [id, id]) };
      if (config.faultStatus && seat === '1:1' && wave === 0) expected.push({ ...base, attempt: 1, native: [], httpStatus: config.faultStatus }, { ...base, attempt: 2, native: native(call), httpStatus: 200 });
      else expected.push({ ...base, attempt: 1, native: native(call), httpStatus: 200 });
    }
  }
  if (!expected.length || expected.length > config.windowLimit) throw new Error('plan exceeds window budget');
  return expected;
}
