import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiProtocol, defaultThinkingMode, type ApiProtocol, type ToolSpec } from '@werewolf/protocol';
import { remoteAdapter, type TranscriptMessage } from '@werewolf/llm';
import { ModelLibrary } from '../src/model-library';
import { SecretBox } from '../src/secret';

// 只做两次合成工具往返，不读取房间，不提交游戏行动，不修改模型名单。
if (!process.argv.includes('--live')) throw new Error('需要显式传入 --live，才调用已添加的模型');
const arg = (name: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const directory = process.env.WEREWOLF_DATA ?? 'data';
const model = new ModelLibrary(SecretBox.fromEnvOrFile(directory), join(directory, 'models.json')).find(arg('model') ?? '');
if (!model?.apiKey) throw new Error('请用 --model 指定有密钥的模型条目 ID');
const protocol: ApiProtocol = apiProtocol(arg('protocol') ?? model.apiProtocol);
const baseUrl = arg('api-base') ?? model.baseUrl;
if (new URL(baseUrl).origin !== new URL(model.baseUrl).origin) throw new Error('测试覆盖地址只能使用原模型相同的 origin；其他入口请先添加模型');
const tools: ToolSpec[] = [{ name: 'ping', title: '兼容性测试', description: '确认接口和工具往返正常。调用一次，填写 {"ok":true}，无需长篇思考。', params: [{ kind: 'boolean', name: 'ok', label: '固定为 true', trueLabel: '确认', falseLabel: '未确认' }] }];
const messages: TranscriptMessage[] = [
  { role: 'system', content: '这是合成接口测试，只使用本次提供的信息，每轮调用一次 ping。以下固定背景用于验证提示词缓存：\n' + '每位玩家各自保留独立的可见信息；裁判负责宣布事实、检查合法行动；工具结果必须与调用编号对应。此处没有真实身份、房间资料或私人发言。\n'.repeat(100) },
  { role: 'user', content: '请调用 ping，ok=true。' },
];
const results: Record<string, unknown>[] = [];
for (let round = 1; round <= 2; round++) {
  const result = await remoteAdapter(protocol).decide({ seat: 1, config: { apiProtocol: protocol, baseUrl, model: model.model, apiKey: model.apiKey, temperature: .7, toolMode: 'tools', timeoutSec: 30, thinkingMode: defaultThinkingMode(baseUrl, model.model, protocol), maxOutputTokens: 4096 }, messages, tools, stream: true, cacheKey: `protocol-probe:${model.id}` });
  const valid = result.ok && result.call?.tool === 'ping' && result.call.args.ok === true;
  const row = { protocol, provider: new URL(baseUrl).host, model: model.model, round, ok: result.ok, valid, latencyMs: result.latencyMs, usage: result.usage, failureKind: result.failureKind, error: result.error };
  results.push(row); console.log(JSON.stringify(row));
  if (!valid || !result.assistant) break;
  messages.push(result.assistant);
  for (const id of result.toolCallIds) messages.push({ role: 'tool', callId: id, content: '已确认，测试成功。' });
  messages.push({ role: 'user', content: '这是下一轮，请再次调用 ping，ok=true。' });
}
mkdirSync(join(directory, 'diagnostics'), { recursive: true });
writeFileSync(join(directory, 'diagnostics', `protocol-probe-${model.id}-${protocol}.json`), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
if (results.length !== 2 || results.some((r) => !r.valid)) process.exitCode = 1;
