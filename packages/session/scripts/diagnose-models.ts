import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMessages, openaiAdapter, type ChatMessage } from '@werewolf/llm';
import { projectSeat, seatTools } from '@werewolf/engine';
import { THINKING_MODES, thinkingOptions, type AuditEntry, type ThinkingMode } from '@werewolf/protocol';
import { ModelLibrary } from '../src/model-library';
import { SecretBox } from '../src/secret';
import type { RoomRecord } from '../src/store';

// 显式 --live 才访问已配置的接口。只保存统计，不保存密钥、请求正文或模型原文。
if (!process.argv.includes('--live')) throw new Error('真实模型测试需显式传入 --live；默认 8 次请求，并发最多 2 个模型。');
const thinkingInput = process.argv.find((arg) => arg.startsWith('--thinking='))?.slice(11) ?? 'default';
if (!THINKING_MODES.includes(thinkingInput as ThinkingMode)) throw new Error(`无效的思考强度：${thinkingInput}`);
const thinkingMode = thinkingInput as ThinkingMode;
const purposeInput = process.argv.find((arg) => arg.startsWith('--purpose='))?.slice(10) ?? 'both';
if (!['both', 'listen', 'action'].includes(purposeInput)) throw new Error('purpose 只能为 both、listen 或 action');
const purposes = (['listen', 'action'] as const).filter((purpose) => purposeInput === 'both' || purposeInput === purpose);
const directory = join(process.cwd(), 'data', 'rooms');
const file = readdirSync(directory).filter((name) => name.endsWith('.audit.jsonl'))
  .sort((a, b) => statSync(join(directory, b)).mtimeMs - statSync(join(directory, a)).mtimeMs)[0];
const roomId = process.argv.find((arg) => arg.startsWith('--room='))?.slice(7) ?? file?.replace('.audit.jsonl', '');
if (!roomId) throw new Error('没有可用于诊断的房间，请通过 --room 指定有审计记录的房间');
if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) throw new Error('非法房间号');
const record = JSON.parse(readFileSync(join(directory, `${roomId}.json`), 'utf8')) as RoomRecord;
const audits = readFileSync(join(directory, `${roomId}.audit.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AuditEntry);
const source = audits.findLast((a) => a.seat === 1 && Array.isArray(a.messages) &&
  (a.messages as ChatMessage[]).at(-1)?.content?.endsWith('你现在可以使用投票工具。'));
if (!source) throw new Error('指定房间没有 1 号的投票请求可供诊断');
const projection = projectSeat(record.state!, record.events, 1);
const tools = seatTools(record.state!, 1);
const system = buildMessages(projection, '在逻辑和直觉之间保持平衡，发言精简。', { speechSec: 180, skillSec: 90 })[0];
const history = structuredClone(source.messages as ChatMessage[]);
history[0] = system;
const speech = record.events.findLast((e) => e.type === 'speech' && e.audience === 'public' && e.payload.seat !== 1)!;
const library = new ModelLibrary(SecretBox.fromEnvOrFile('data'), join('data', 'models.json'));
const models = library.list();
const requested = process.argv.find((arg) => arg.startsWith('--models='))?.slice(9).split(',');
const selections = [
  ['token-plan', 'qwen3.8-flash'], ['token-plan', 'qwen3.8-max-preview'],
  ['token-plan', 'deepseek-v4-pro'], ['maas', 'qwen3.8-flash'],
];
const targets = selections.filter(([, model]) => !requested || requested.includes(model)).map(([provider, model]) => models.find((m) => m.model === model && m.apiKey &&
  (provider === 'token-plan' ? new URL(m.baseUrl).host.startsWith('token-plan.') : new URL(m.baseUrl).host === 'maas.qianwenaiapi.com'))).filter((m) => !!m);
if (!targets.length) throw new Error('没有找到匹配的已配置 Token Plan / 千问模型');
for (const target of targets) {
  const option = thinkingOptions(target.baseUrl, target.model).find((o) => o.value === thinkingMode)!;
  if (!option.supported) throw new Error(`${target.model}：${option.hint}`);
}
const suffix = thinkingMode === 'default' ? 'latest' : thinkingMode === 'off' ? 'fast' : thinkingMode;
const output = `data/diagnostics/model-probe-${suffix}${purposeInput === 'both' ? '' : `-${purposeInput}`}.json`;
const results: Record<string, unknown>[] = [];
async function probe(model: (typeof targets)[number]) {
  for (const purpose of purposes) {
    const messages = structuredClone(history);
    if (purpose === 'listen') messages[messages.length - 1] = {
      role: 'user', name: String(speech.payload.seat),
      content: `第${speech.day}天${speech.payload.seat}号发言：${speech.payload.content}\n不是你的发言轮次，不要调用工具。`,
    };
    const started = Date.now();
    let firstDeltaMs: number | undefined;
    const result = await openaiAdapter.decide({
      seat: 1, messages, tools, stream: true, toolChoice: purpose === 'listen' ? 'auto' : 'required',
      config: { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey, temperature: 0.7, toolMode: 'tools', timeoutSec: 90, thinkingMode },
      onDelta: () => { firstDeltaMs ??= Date.now() - started; },
    });
    const valid = result.ok && (purpose === 'listen' ? !result.call : result.call?.tool === 'vote');
    const row = {
      provider: new URL(model.baseUrl).host, model: model.model, purpose, thinkingMode, ok: result.ok, valid,
      latencyMs: result.latencyMs, firstDeltaMs, tool: result.call?.tool,
      thinkingChars: result.thinking?.length ?? 0, replyChars: result.reply?.length ?? 0,
      failureKind: result.failureKind, error: result.error, inputChars: JSON.stringify(messages).length,
    };
    results.push(row);
    console.log(JSON.stringify(row));
    mkdirSync('data/diagnostics', { recursive: true });
    writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), sourceRoom: roomId, results }, null, 2));
  }
}
let next = 0;
await Promise.all(Array.from({ length: 2 }, async () => {
  for (;;) { const target = targets[next++]; if (!target) return; await probe(target); }
}));
