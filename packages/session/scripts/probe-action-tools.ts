import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actionMenu, apiProtocol, defaultThinkingMode, expandActionTools, type ApiProtocol, type AuditEntry, type ToolCall, type ToolSpec } from '@werewolf/protocol';
import { buildRules, createGame, projectSeat, replay, seatTools, submit } from '@werewolf/engine';
import { buildMessages, migrateTranscript, remoteAdapter, styleText, type AdapterConfig, type TranscriptMessage } from '@werewolf/llm';
import { ModelLibrary } from '../src/model-library';
import { SecretBox } from '../src/secret';
import type { RoomRecord } from '../src/store';

// 只读取配置和历史副本，在内存中校验动作。永不创建/恢复 RoomManager，不写入真实房间。
if (!process.argv.includes('--live')) throw new Error('实际模型测试需要 --live');
const arg = (name: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const directory = process.env.WEREWOLF_DATA ?? 'data';
if (!process.env.WEREWOLF_SECRET && !existsSync(join(directory, 'secret.key'))) throw new Error('未发现已有主密钥，不为探针生成新密钥');
const secrets = SecretBox.fromEnvOrFile(directory);
const roomId = arg('room');
if (roomId && !/^[a-zA-Z0-9_-]+$/.test(roomId)) throw new Error('room 只接受房间 ID');
const record: RoomRecord | undefined = roomId ? JSON.parse(readFileSync(join(directory, 'rooms', `${roomId}.json`), 'utf8')) : undefined;
const audit: AuditEntry | undefined = record ? readFileSync(join(directory, 'rooms', `${roomId}.audit.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry).find((a) => a.id === Number(arg('audit'))) : undefined;
if (record && (!audit || audit.purpose !== 'action' || audit.toolCall?.tool !== 'witch_act' || !Array.isArray(audit.messages))) throw new Error('现场副本需要 --audit 指定原女巫首次行动的审计 ID');
const originalSeat = audit ? record?.seats[audit.seat - 1] : undefined;
const selected = new ModelLibrary(secrets, join(directory, 'models.json')).find(arg('model') ?? '');
const original = arg('model') === 'original' && originalSeat;
if (!selected && !original) throw new Error('--model 需要已有条目 ID；提供现场时可用 original');
const source = selected ?? { model: originalSeat!.model, baseUrl: originalSeat!.baseUrl, apiProtocol: originalSeat!.apiProtocol, apiKey: originalSeat!.apiKeyEnc ? secrets.decrypt(originalSeat!.apiKeyEnc) : null };
if (record && (source.model !== originalSeat!.model || new URL(source.baseUrl).origin !== new URL(originalSeat!.baseUrl).origin)) throw new Error('真实上下文只回放给原提供方的原模型；其他模型请只测试合成场景');
const protocol: ApiProtocol = apiProtocol(arg('protocol') ?? source.apiProtocol);
const baseUrl = arg('api-base') ?? source.baseUrl;
if (new URL(baseUrl).origin !== new URL(source.baseUrl).origin) throw new Error('覆盖接口只接受原模型的同源入口');
if (!source.apiKey) throw new Error('所选模型没有可用密钥');
const config: AdapterConfig = { apiProtocol: protocol, baseUrl, model: source.model, apiKey: source.apiKey, temperature: .7, timeoutSec: 45, maxOutputTokens: 4096, toolMode: 'tools', thinkingMode: defaultThinkingMode(baseUrl, source.model, protocol) };
const deal = ['werewolf', 'werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];
const fixture = createGame({ id: 'tool-design-probe', seed: 'tool-design', rules: buildRules('standard12'), deal }).state;
interface Case { name: string; seat: number; tools: ToolSpec[]; messages: TranscriptMessage[]; expected: ToolCall; check?: (call: ToolCall) => { valid: boolean; effects: string[] }; }
const cases: Case[] = [];
if (record && audit) {
  const index = record.actions.findIndex((a) => a.seat === audit.seat && a.decisionId === audit.decisionId);
  if (index < 0 || !record.rules || !record.seed) throw new Error('现场缺少可重放规则或行动');
  const restored = replay({ id: record.id, seed: record.seed, rules: record.rules, names: record.seats.map((s) => s.name), deal: record.state!.history.deal }, record.actions.slice(0, index));
  const state = structuredClone(restored.state);
  if (state.pending?.id !== audit.decisionId || state.players[audit.seat - 1].role !== 'witch') throw new Error('现场重放未还原到女巫行动前');
  state.rules.toolsetVersion = 2;
  for (const seat of state.pending.actors) state.pending.tools[seat] = expandActionTools(state.pending.tools[seat], state.rules);
  const projection = projectSeat(state, restored.events, audit.seat);
  if (!Array.isArray(audit.messages)) throw new Error('现场审计缺少座位上下文');
  const messages = migrateTranscript(structuredClone(audit.messages));
  messages[0] = buildMessages(projection, styleText(originalSeat!.style, originalSeat!.persona))[0];
  messages[messages.length - 1] = { role: 'user', name: 'judge', content: `法官：${state.pending.prompts[audit.seat]}\n${actionMenu(state.pending.tools[audit.seat])}\n现在轮到你行动，请调用本轮菜单中的一个工具。` };
  cases.push({ name: 'witch_record', seat: audit.seat, tools: seatTools(state, audit.seat), messages, expected: { tool: 'witch_save', args: {} }, check: (call) => {
    const result = submit(state, { seat: audit.seat, call, decisionId: audit.decisionId });
    return { valid: !result.error, effects: result.events.filter((e) => /^witch\.(save|poison|idle)$/.test(e.type)).map((e) => `${e.type}:${e.payload.target ?? ''}`) };
  } });
}

const definitions: { name: string; seat: number; allowed: string[]; instruction: string; expected: ToolCall }[] = [
  { name: 'witch_save', seat: 6, allowed: ['witch_save', 'witch_poison', 'witch_skip'], instruction: '狼人刀口为7号，你有解药和毒药。本轮最终决定只使用解药救7号。', expected: { tool: 'witch_save', args: {} } },
  { name: 'witch_poison', seat: 6, allowed: ['witch_save', 'witch_poison', 'witch_skip'], instruction: '狼人刀口为7号，你有两瓶药。本轮最终决定只毒12号。', expected: { tool: 'witch_poison', args: { targetSeat: 12 } } },
  { name: 'witch_skip', seat: 6, allowed: ['witch_save', 'witch_poison', 'witch_skip'], instruction: '狼人刀口为7号，你有两瓶药。本轮最终决定两瓶药都不用。', expected: { tool: 'witch_skip', args: {} } },
  { name: 'badge_transfer', seat: 9, allowed: ['badge_transfer', 'badge_tear'], instruction: '你已出局，需要处理警徽。可接收的座位依次为2、5、12号。本轮最终决定把警徽移交给12号。', expected: { tool: 'badge_transfer', args: { recipientSeat: 12 } } },
  { name: 'badge_tear', seat: 9, allowed: ['badge_transfer', 'badge_tear'], instruction: '你已出局，需要处理警徽。本轮最终决定撕毁警徽。', expected: { tool: 'badge_tear', args: {} } },
  { name: 'hunter_hold_fire', seat: 7, allowed: ['hunter_shoot', 'hunter_hold_fire'], instruction: '你是刚出局的猎人，可以开枪。本轮最终决定不开枪。', expected: { tool: 'hunter_hold_fire', args: {} } },
  { name: 'sheriff_stay_off', seat: 9, allowed: ['sheriff_signup', 'sheriff_stay_off'], instruction: '法官正在询问是否上警。本轮最终决定不上警。', expected: { tool: 'sheriff_stay_off', args: {} } },
  { name: 'wolf_decline_explode', seat: 1, allowed: ['wolf_explode', 'wolf_decline_explode'], instruction: '法官正在发言前询问是否自爆。你是狼人，本次最终决定不自爆。', expected: { tool: 'wolf_decline_explode', args: {} } },
  { name: 'wolf_empty_kill', seat: 1, allowed: ['wolf_kill', 'wolf_empty_kill'], instruction: '本轮狼人落刀允许空刀。本轮最终决定你自己提交空刀，由其他狼人的选择参与合刀。', expected: { tool: 'wolf_empty_kill', args: {} } },
  { name: 'vote_abstain', seat: 9, allowed: ['vote', 'vote_abstain'], instruction: '本轮是放逐投票，允许弃票。本轮最终决定弃票。', expected: { tool: 'vote_abstain', args: {} } },
  { name: 'guard_skip', seat: 8, allowed: ['guard_protect', 'guard_skip'], instruction: '本轮是守卫夜间行动，允许空守。本轮最终决定空守。', expected: { tool: 'guard_skip', args: {} } },
  { name: 'seer_target', seat: 5, allowed: ['seer_inspect'], instruction: '本轮是预言家查验。可查验座位依次为2、12号。本轮最终决定查验12号。', expected: { tool: 'seer_inspect', args: { targetSeat: 12 } } },
];
for (const def of definitions) {
  const tools = seatTools(fixture, def.seat);
  const legal = tools.filter((t) => def.allowed.includes(t.name)).map((t) => ({ ...t, params: t.params.map((p) => p.kind === 'seat' ? { ...p, options: [2, 5, 12].filter((s) => s !== def.seat) } : p) }));
  cases.push({ ...def, tools, messages: [{ role: 'system', content: '这是狼人杀工具易用性测试，只验证已经确定的决定能否正确提交。每轮只调用一个工具，不需要重新做策略推理。目录列出整局能力，当前只允许最新法官菜单中的动作和目标。' }, { role: 'user', name: 'judge', content: `法官：${def.instruction}\n${actionMenu(legal)}\n现在轮到你行动，请调用本轮菜单中的一个工具。` }] });
}
const wanted = arg('cases')?.split(',');
const selectedCases = wanted ? cases.filter((c) => wanted.includes(c.name)) : cases;
if (!selectedCases.length || (wanted && wanted.some((name) => !selectedCases.some((c) => c.name === name)))) throw new Error('未找到指定测试场景');
const repeats = Math.max(1, Math.min(5, Number(arg('repeat') ?? 1)));
if (!Number.isInteger(repeats)) throw new Error('repeat 必须为 1–5 的整数');
const queue = Array.from({ length: repeats }, (_, i) => selectedCases.map((c) => ({ c, round: i + 1 }))).flat();
const results: Record<string, unknown>[] = [];
async function worker() {
  while (queue.length) {
    const { c, round } = queue.shift()!;
    const result = await remoteAdapter(protocol).decide({ seat: c.seat, config, tools: c.tools, messages: structuredClone(c.messages), stream: true, cacheKey: `action-design-probe:${selected?.id ?? 'original'}:${c.name}` });
    const checked = result.call && c.check?.(result.call);
    const matches = !!result.call && result.call.tool === c.expected.tool && JSON.stringify(result.call.args) === JSON.stringify(c.expected.args);
    const row = { scenario: c.name, round, protocol, provider: new URL(baseUrl).host, model: source.model, valid: result.ok && (checked?.valid ?? matches), expectedMatch: matches, call: result.call, effects: checked?.effects, latencyMs: result.latencyMs, thinkingChars: result.thinking?.length ?? 0, usage: result.usage, error: result.error, failureKind: result.failureKind };
    results.push(row); console.log(JSON.stringify(row));
  }
}
await Promise.all([worker(), worker()]);
mkdirSync(join(directory, 'diagnostics'), { recursive: true });
const tag = (selected?.id ?? 'original').replace(/[^a-zA-Z0-9_-]/g, '_');
const at = new Date().toISOString();
writeFileSync(join(directory, 'diagnostics', `action-tools-${tag}-${protocol}-${at.replace(/[:.]/g, '-')}.json`), JSON.stringify({ at, results }, null, 2));
if (results.some((r) => !r.valid)) process.exitCode = 1;
