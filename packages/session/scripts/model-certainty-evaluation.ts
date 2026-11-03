/** 预注册的表达诊断；隐藏双生局只在离线证明等值，真实服务只接收座位投影。 */
import { deepStrictEqual } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { submit } from '@werewolf/engine';
import { buildMessages, openaiAdapter, type TranscriptMessage } from '@werewolf/llm';
import { thinkingParameters, type ThinkingMode } from '@werewolf/protocol';
import { TestGame, DEAL9 } from '../../engine/test/harness';
import { ModelLibrary } from '../src/model-library';
import { SecretBox } from '../src/secret';

export const CERTAINTY_CANDIDATE = '在自己判断局势时，区分已确认的事实、玩家声称和自己的推测；结论仍有符合规则的其他可能时，不要把倾向当作必然，也不要把推测的死因或他人的私密通知当作已知。公开发言仍可按真实阵营的策略隐瞒或声称身份。';
export const CERTAINTY_RUBRIC = {
  version: 1,
  unit: '被测平民实际公开发言中的证据确定性，不判断模型内在记忆或投票策略',
  fail: '明确将未确认身份/玩家查杀升格为法官或客观事实；明确断言对跳必定一真一假/不可能双狼；须有同公开投影且规则可达的反例。',
  pass: '有可判定的局势表达，并将对跳/查杀作为声称、倾向或可能性；说我更信/站/投某人不是事实错误。',
  unassessable: '只有口号、未涉及局势、句法或策略含义有歧义；失败响应也不当作事实错误。',
  exclusions: '不因上帝知道底牌给分；不要求玩家公开私密信息或狼人诚实；无可达规则反例时不扣分。',
  reproducibilityGate: '发现阶段至少两条明确失败且跨至少两个公开变体，才测试候选；否则不改生产提示。',
  adoptionGate: '留出配对验证候选失败数低于同批基线且合法交付不下降，才考虑最小提示修改；只限样本的改善，不宣称普遍能力提升。',
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const twinDeal = ['seer', 'werewolf', 'werewolf', 'werewolf', 'witch', 'hunter', 'villager', 'villager', 'villager'];

function initial(seed: string, twin: boolean) {
  const g = new TestGame({ deal: twin ? twinDeal : DEAL9, values: { 'sheriff.enabled': false }, seed });
  g.night({ kill: null, inspect: twin ? 2 : 1 });
  return g;
}

function scene(stage: 'discovery' | 'holdout', wording: number, reverse: boolean) {
  let seed = '', first: TestGame | undefined;
  for (let i = 0; i < 500; i++) {
    const candidate = `certainty-${stage}-${reverse ? 'ba' : 'ab'}-${i}`;
    const g = initial(candidate, false);
    if (g.state.dayState.firstSpeaker === (reverse ? 2 : 1) && g.state.dayState.direction === (reverse ? 'counterclockwise' : 'clockwise')) { first = g; seed = candidate; break; }
  }
  if (!first) throw Error('没有找到指定发言次序的固定种子');
  const bodies = stage === 'discovery'
    ? wording === 0
      ? ['我是预言家，昨夜查验2号是狼人。', '我是预言家，昨夜查验1号是狼人。']
      : ['我才是真预言家，2号是我的查杀，这是确定信息。', '我才是真预言家，1号是我的查杀，这是确定信息。']
    : wording === 0
      ? ['我跳预言家，昨夜验2号为狼，建议今天投他。', '我跳预言家，昨夜验1号为狼，建议今天投他。']
      : ['我的身份是预言家，验人结果给2号一张狼人牌，请各位认真判断。', '我的身份是预言家，验人结果给1号一张狼人牌，请各位认真判断。'];
  const advance = (g: TestGame) => {
    g.until((v) => v.hasTool('speak') && v.waiting()[0] === 8, (seat, tools) => tools.some((t) => t.name === 'speak')
      ? { tool: 'speak', args: { content: seat === 1 ? bodies[0] : seat === 2 ? bodies[1] : '我没有私密查验，先听其他人的说法。' } } : undefined);
    const projection = g.view(8);
    const messages = buildMessages(projection, '冷静，根据实际知道的信息作出决定。');
    return { state: g.state, projection, messages, tools: projection.task!.tools };
  };
  const a = advance(first), b = advance(initial(seed, true));
  deepStrictEqual(a.projection, b.projection); deepStrictEqual(a.messages, b.messages); deepStrictEqual(a.tools, b.tools);
  const order = a.projection.events.filter((e) => e.type === 'speech').map((e) => e.payload.seat);
  if (reverse ? order.indexOf(2) >= order.indexOf(1) : order.indexOf(1) >= order.indexOf(2)) throw Error('发言次序不符合预注册条件');
  return { id: `${stage}-w${wording}-${reverse ? 'ba' : 'ab'}`, seed, ...a, twinVerified: true, visibleHash: hash({ projection: a.projection, messages: a.messages, tools: a.tools }) };
}

export function certaintyScenes(stage: 'discovery' | 'holdout') {
  return [0, 1].flatMap((wording) => [false, true].map((reverse) => scene(stage, wording, reverse)));
}
export function candidateMessages(messages: TranscriptMessage[]) {
  return messages.map((m) => m.role === 'system' ? { ...m, content: m.content!.replace('【输出要求】', `${CERTAINTY_CANDIDATE}\n\n【输出要求】`) } : { ...m });
}

async function run() {
  const stage = process.argv.includes('--holdout') ? 'holdout' : 'discovery';
  const live = process.argv.includes('--live');
  const output = resolve(process.argv.find((x) => x.startsWith('--output='))?.slice(9) ?? `data/diagnostics/certainty/${stage}.json`);
  if (existsSync(output)) throw Error('输出已存在；使用新的 --output= 路径保留旧样本。');
  const cases = certaintyScenes(stage);
  const conditions = stage === 'discovery' ? ['baseline'] as const : ['baseline', 'candidate'] as const;
  const modes: ThinkingMode[] = ['off', 'high'];
  const manifest = { version: 1, stage, rubric: CERTAINTY_RUBRIC, candidate: CERTAINTY_CANDIDATE, model: 'deepseek-v4-flash-0731', protocol: 'chat_completions',
    temperature: 0, timeoutSec: 90, repeats: 2, modes, conditions, plannedLogicalCalls: stage === 'discovery' ? 16 : 32,
    cases: cases.map(({ state: _state, ...c }) => c), sourceSha256: Object.fromEntries(['packages/session/scripts/model-certainty-evaluation.ts', 'packages/llm/src/prompt.ts', 'packages/protocol/src/thinking.ts'].map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])) };
  mkdirSync(resolve(output, '..'), { recursive: true });
  const rows: Record<string, unknown>[] = [];
  const result = { at: new Date().toISOString(), manifest, manifestHash: hash(manifest), rows, complete: false, dryRun: !live };
  const save = () => writeFileSync(output, JSON.stringify(result, null, 2));
  save();
  if (!live) { console.log(JSON.stringify({ output, cases: cases.length, calls: manifest.plannedLogicalCalls, twinVerified: true })); return; }
  if (!existsSync('data/models.json') || !existsSync('data/secret.key') && !process.env.WEREWOLF_SECRET) throw Error('需要现有项目模型库和主密钥；不创建配置。');
  const model = new ModelLibrary(SecretBox.fromEnvOrFile('data'), 'data/models.json').list().find((m) => m.model === manifest.model && m.apiProtocol === 'chat_completions' && m.lifecycle === 'active' && !m.mergedInto && new URL(m.baseUrl).hostname === 'token-plan.maas.qianwenaiapi.com' && m.apiKey);
  if (!model) throw Error('指定现有型号/接入不可用；不切换服务。');
  let logicalIndex = 0;
  for (let repeat = 0; repeat < 2; repeat++) for (const c of cases) for (const thinkingMode of repeat ? [...modes].reverse() : modes) for (const condition of repeat ? [...conditions].reverse() : conditions) {
    const messages = condition === 'candidate' ? candidateMessages(c.messages) : c.messages;
    let requests = 0;
    const answer = await openaiAdapter.decide({ seat: 8, projection: c.projection, messages, tools: c.tools, stream: false,
      config: { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey, temperature: 0, toolMode: 'tools', timeoutSec: 90, thinkingMode },
      onRequest: () => { requests++; } });
    const applied = answer.call ? submit(c.state, { seat: 8, decisionId: c.projection.task!.decisionId, call: answer.call }) : undefined;
    const raw = answer.raw as { model?: unknown; choices?: { finish_reason?: unknown }[] } | undefined;
    rows.push({ id: randomUUID(), logicalIndex: ++logicalIndex, scene: c.id, condition, thinkingMode, repeat: repeat + 1, visibleHash: c.visibleHash, messagesHash: hash(messages),
      parameters: thinkingParameters(model.baseUrl, model.model, thinkingMode), ok: answer.ok, legal: answer.ok && !!applied && !applied.error,
      call: answer.call, latencyMs: answer.latencyMs, usage: answer.usage, failureKind: answer.failureKind, encodedVariants: requests,
      responseModel: typeof raw?.model === 'string' ? raw.model : null, finishReason: raw?.choices?.[0]?.finish_reason ?? null });
    save(); console.log(JSON.stringify({ stage, completed: rows.length, planned: manifest.plannedLogicalCalls, ok: answer.ok, legal: answer.ok && !!applied && !applied.error }));
  }
  result.complete = true; save();
  const blindRows = rows.map((r) => ({ sampleId: r.id, projection: cases.find((c) => c.id === r.scene)!.projection, call: r.call ?? null, delivered: r.ok }));
  // 无分组标签、时延、底牌、seed或system提示；随机打乱，映射保留在私有运行文件中。
  blindRows.sort(() => Math.random() - .5);
  writeFileSync(output.replace(/\.json$/, '-blind.json'), JSON.stringify({ rubric: CERTAINTY_RUBRIC, samples: blindRows }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
