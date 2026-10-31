import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { THINKING_MODES, thinkingOptions, type AuditEntry, type ThinkingMode } from '@werewolf/protocol';
import { seatTools } from '@werewolf/engine';
import { openaiAdapter, type ChatMessage } from '@werewolf/llm';
import { SecretBox } from '../src/secret';
import { ModelLibrary } from '../src/model-library';
import type { RoomRecord } from '../src/store';

// 默认只读统计。--live 才将指定座位的历史超时输入发送给同一已配置模型；不提交游戏行动。
const arg = (name: string) => process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
const roomId = arg('room');
if (!roomId || !/^[a-zA-Z0-9_-]+$/.test(roomId)) throw new Error('请用 --room 指定房间');
const directory = process.env.WEREWOLF_DATA ?? 'data';
const record = JSON.parse(readFileSync(join(directory, 'rooms', `${roomId}.json`), 'utf8')) as RoomRecord;
const rows = readFileSync(join(directory, 'rooms', `${roomId}.audit.jsonl`), 'utf8').split('\n').flatMap((line) => {
  if (!line.trim()) return [];
  try { return [JSON.parse(line) as AuditEntry]; } catch { return []; } // 正在追加的末行留待下次读取。
});
const timedOut = (a: AuditEntry) => a.failureKind === 'timeout' || /^超过/.test(a.error ?? '');
const summary = ['listen', 'action'].map((purpose) => {
  const group = rows.filter((a) => a.purpose === purpose);
  const latencies = group.map((a) => a.latencyMs).filter((n): n is number => typeof n === 'number').sort((a, b) => a - b);
  return { purpose, requests: group.length, timeouts: group.filter(timedOut).length, medianMs: latencies[Math.floor(latencies.length / 2)], p90Ms: latencies[Math.floor(latencies.length * .9)] };
});
const results: Record<string, unknown>[] = [];
const save = () => {
  mkdirSync(join(directory, 'diagnostics'), { recursive: true });
  writeFileSync(join(directory, 'diagnostics', `timeouts-${roomId}.json`), JSON.stringify({ at: new Date().toISOString(), roomId, summary, results }, null, 2));
};
console.log(JSON.stringify({ roomId, summary }));
save();
if (process.argv.includes('--live')) {
  const seats = [...new Set((arg('seats') ?? '').split(',').map(Number))];
  if (!seats.length || seats.some((s) => !Number.isInteger(s) || s < 1 || s > record.seats.length)) throw new Error('--live 必须用 --seats 显式指定要测试的座位');
  const mode = (arg('thinking') ?? 'low') as ThinkingMode;
  if (!THINKING_MODES.includes(mode)) throw new Error('无效的思考档位');
  const secrets = SecretBox.fromEnvOrFile(directory);
  const library = new ModelLibrary(secrets, join(directory, 'models.json'));
  const targets = seats.map((seat) => {
    const cfg = record.seats[seat - 1];
    const model = cfg.modelId ? library.find(cfg.modelId) : undefined;
    const baseUrl = model?.baseUrl ?? cfg.baseUrl;
    const name = model?.model ?? cfg.model;
    if (!thinkingOptions(baseUrl, name).some((o) => o.value === mode && o.supported)) throw new Error(`${seat}号的入口不支持${mode}`);
    const sample = rows.findLast((a) => a.seat === seat && a.purpose === 'action' && timedOut(a) && Array.isArray(a.messages));
    if (!sample) throw new Error(`${seat}号没有正式行动超时样本`);
    const step = record.events.find((e) => e.payload.decisionId === sample.decisionId)?.payload.step;
    return { seat, cfg, sample, step, baseUrl, name, apiKey: model?.apiKey ?? (cfg.apiKeyEnc ? secrets.decrypt(cfg.apiKeyEnc) : null) };
  });
  // 同时最多两个真实请求；只保存数值统计与错误，不保存密钥或请求原文。
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
    for (;;) {
      const t = targets[next++]; if (!t) return;
      const start = Date.now(); let firstDeltaMs: number | undefined;
      const result = await openaiAdapter.decide({
        seat: t.seat, messages: structuredClone(t.sample.messages as ChatMessage[]), tools: seatTools(record.state!, t.seat), stream: true, toolChoice: 'required',
        config: { baseUrl: t.baseUrl, model: t.name, apiKey: t.apiKey, temperature: t.cfg.temperature, toolMode: t.cfg.toolMode, timeoutSec: t.step === 'speech' ? 180 : 90, thinkingMode: mode },
        onDelta: () => { firstDeltaMs ??= Date.now() - start; },
      });
      const expected = t.step === 'speech' ? 'speak' : t.step === 'exile.vote' ? 'vote' : t.step === 'sheriff.vote' ? 'sheriff_vote' : undefined;
      const row = { seat: t.seat, provider: new URL(t.baseUrl).host, model: t.name, step: t.step, thinkingMode: mode, ok: result.ok, expectedTool: expected, tool: result.call?.tool, valid: result.ok && !!result.call && (!expected || result.call.tool === expected), latencyMs: result.latencyMs, firstDeltaMs, thinkingChars: result.thinking?.length ?? 0, replyChars: result.reply?.length ?? 0, failureKind: result.failureKind, error: result.error };
      results.push(row); console.log(JSON.stringify(row)); save();
    }
  }));
}
