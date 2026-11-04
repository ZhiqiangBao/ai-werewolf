import { createHash } from 'node:crypto';
import type { ApiProtocol, AuditEntry } from '@werewolf/protocol';
import { anthropicInput, chatMessages, migrateTranscript, protocolBinding, responsesInput, type AdapterConfig, type TranscriptMessage } from '@werewolf/llm';
import { apiUrl, thinkingParameters } from '@werewolf/protocol';
import { replayRequest, type ReplayOutput, type ReplayWireRequest } from './replay-transport';

export interface Rubric {
  targetError: string;
  expected: string;
  evidence: string[];
  exclusions: string[];
}

export interface FrozenCase {
  version: 1;
  caseId: string;
  synthetic: boolean;
  createdAt: string;
  source: { roomId: string; auditId: number; seat: number; decisionId: string; projectionVersion: number; at: number; model: string; purpose?: 'listen' | 'action'; attempt?: number };
  apiProtocol: ApiProtocol;
  fidelity: 'captured' | 'reconstructed' | 'incomplete';
  notes: string[];
  messages: TranscriptMessage[];
  request?: ReplayWireRequest;
  original: { response?: unknown; toolCall?: unknown; error?: string };
  rubric: Rubric;
  caseHash: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim();

export function validateWire(request: ReplayWireRequest): void {
  if (!object(request) || !object(request.body) || !nonempty(request.body.model) || !nonempty(request.binding) || !Number.isFinite(request.timeoutSec) || request.timeoutSec <= 0 || request.timeoutSec > 600) throw Error('REQUEST_INVALID: 请求必须含 model、binding 和 0–600 秒时限');
  const url = new URL(request.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('ENDPOINT_UNSAFE: 请求地址不能携带凭证、查询参数或片段');
  if (Object.keys(request).some((k) => !['endpoint', 'body', 'binding', 'timeoutSec'].includes(k)) || Object.keys(request.body).some((k) => /^(?:headers|authorization|api[_-]?key|access[_-]?token)$/i.test(k))) throw Error('REQUEST_CREDENTIAL_FIELD: 不接受认证字段');
}

export function validateRubric(rubric: Rubric): void {
  if (!object(rubric) || !nonempty(rubric.targetError) || !nonempty(rubric.expected) || !Array.isArray(rubric.evidence) || !rubric.evidence.length || !rubric.evidence.every(nonempty) || !Array.isArray(rubric.exclusions) || !rubric.exclusions.every(nonempty)) throw Error('RUBRIC_INVALID: 请填写目标错误、期望、证据和排除情形');
}

export function assertCredentialRoute(request: ReplayWireRequest, config: AdapterConfig): void {
  validateWire(request);
  const protocol = config.apiProtocol ?? 'chat_completions';
  if (request.endpoint !== apiUrl(config.baseUrl, protocol) || request.binding !== protocolBinding(config) || request.body.model !== config.model) throw Error('BINDING_MISMATCH: 请求地址、模型或凭据绑定不属于所选模型');
}

function validateMessages(messages: unknown): asserts messages is TranscriptMessage[] {
  if (!Array.isArray(messages) || !messages.length || messages.some((m) => !object(m) || !['system', 'user', 'assistant', 'tool'].includes(m.role) || !(typeof m.content === 'string' || m.role === 'assistant' && m.content === null))) throw Error('MESSAGES_MISSING: 审计没有完整语义消息，不能从当前房间补造');
}

export function freezeAudit(audit: AuditEntry, options: { roomId: string; caseId: string; rubric: Rubric; reconstructed?: ReplayWireRequest; synthetic?: boolean }): FrozenCase {
  validateRubric(options.rubric);
  validateMessages(audit.messages);
  if (!Number.isSafeInteger(audit.id) || audit.id < 1 || !Number.isSafeInteger(audit.seat) || audit.seat < 1 || !nonempty(options.caseId) || !nonempty(options.roomId)) throw Error('SOURCE_INVALID: 需要明确的房间、审计和座位');
  const protocol = audit.apiProtocol ?? audit.request?.apiProtocol;
  if (!protocol || !['chat_completions', 'responses', 'anthropic_messages'].includes(protocol)) throw Error('PROTOCOL_MISSING: 不能猜测历史协议');
  const captured = (audit.request as { replay?: ReplayWireRequest } | undefined)?.replay;
  const request = captured ?? options.reconstructed;
  if (request) validateWire(request);
  const notes = ['冻结的是该次调用前输入；未恢复历史引擎状态，不验证行动结算或整局胜率。'];
  if (!captured) notes.push(request ? '请求由操作者显式重建；不能当作原始 HTTP 请求。' : '旧审计缺少实际编码请求；可以保存现场，但不能重放。');
  if (options.synthetic) notes.push('合成诊断案例，不是真实对局故障。');
  const payload: Omit<FrozenCase, 'caseHash'> = {
    version: 1, caseId: options.caseId, synthetic: !!options.synthetic, createdAt: new Date().toISOString(),
    source: { roomId: options.roomId, auditId: audit.id, seat: audit.seat, decisionId: audit.decisionId, projectionVersion: audit.projectionVersion, at: audit.at, model: audit.model, ...(audit.purpose ? { purpose: audit.purpose } : {}), ...(audit.attempt ? { attempt: audit.attempt } : {}) },
    apiProtocol: protocol, fidelity: captured ? 'captured' : request ? 'reconstructed' : 'incomplete', notes,
    messages: structuredClone(audit.messages), ...(request ? { request: structuredClone(request) } : {}),
    original: { response: audit.response, toolCall: audit.toolCall, error: audit.error }, rubric: structuredClone(options.rubric),
  };
  // JSON round trip gives the saved representation, including omitted undefined fields.
  const saved = JSON.parse(JSON.stringify(payload)) as Omit<FrozenCase, 'caseHash'>;
  return { ...saved, caseHash: digest(saved) };
}

export function verifyCase(value: unknown): asserts value is FrozenCase {
  if (!object(value) || value.version !== 1 || !nonempty(value.caseHash)) throw Error('CASE_INVALID: 不支持的现场文件');
  const { caseHash, ...payload } = value;
  if (digest(payload) !== caseHash) throw Error('CASE_HASH_MISMATCH: 现场已变化，请保留原件并重新冻结');
  validateRubric(value.rubric);
  validateMessages(value.messages);
  if (!['chat_completions', 'responses', 'anthropic_messages'].includes(value.apiProtocol) || !['captured', 'reconstructed', 'incomplete'].includes(value.fidelity) || !object(value.source)) throw Error('CASE_INVALID: 缺少来源或协议');
  if (value.request) validateWire(value.request);
}

/** 只替换第一个系统块；JSON 兼容模式附加的格式说明等其他内容保持原样。 */
export function systemText(request: ReplayWireRequest, protocol: ApiProtocol, replacement?: string): string {
  const body = request.body;
  const blocks = protocol === 'anthropic_messages' ? body.system : protocol === 'responses' ? body.input : body.messages;
  if (protocol === 'anthropic_messages' && typeof blocks === 'string') {
    if (replacement !== undefined) body.system = replacement;
    return blocks;
  }
  if (!Array.isArray(blocks)) throw Error('SYSTEM_NOT_FOUND: 找不到可替换的系统块');
  const block = blocks.find((b: any) => object(b) && (protocol === 'anthropic_messages' ? b.type === 'text' : b.role === 'system'));
  const key = protocol === 'anthropic_messages' ? 'text' : 'content';
  if (!block || typeof block[key] !== 'string') throw Error('SYSTEM_NOT_FOUND: 首版只支持字符串系统块');
  const original = block[key];
  if (replacement !== undefined) block[key] = replacement;
  return original;
}

/** 跨模型只迁移语义消息和工具 Schema，不带原生签名或推理块。 */
export function portableRequest(frozen: FrozenCase, config: AdapterConfig): ReplayWireRequest {
  if (!frozen.request) throw Error('REQUEST_MISSING: 先补齐历史请求');
  const sourceTools = frozen.request.body.tools;
  if (!Array.isArray(sourceTools) || !sourceTools.length) throw Error('PORTABLE_TOOLS_MISSING: 首版不迁移 JSON 兼容或无工具请求');
  const tools = sourceTools.map((tool: any) => {
    const t = tool.function ?? tool;
    if (!nonempty(t.name) || !object(t.parameters ?? t.input_schema)) throw Error('TOOL_SCHEMA_INVALID');
    return { name: t.name, description: t.description ?? '', parameters: t.parameters ?? t.input_schema };
  });
  const messages = migrateTranscript(frozen.messages).map((m): TranscriptMessage => {
    if (m.role !== 'assistant') return structuredClone(m);
    return { role: 'assistant', content: m.content, ...(m.calls ? { calls: structuredClone(m.calls) } : {}) };
  });
  const protocol = config.apiProtocol ?? 'chat_completions';
  const thinking = thinkingParameters(config.baseUrl, config.model, config.thinkingMode, protocol);
  const listen = frozen.source.purpose === 'listen';
  let body: Record<string, unknown>;
  if (protocol === 'responses') {
    body = { model: config.model, input: responsesInput(messages, config), store: false, include: ['reasoning.encrypted_content'], ...thinking,
      max_output_tokens: config.maxOutputTokens ?? 4096, tools: tools.map((t) => ({ type: 'function', ...t, strict: true })), tool_choice: listen ? 'auto' : 'required', parallel_tool_calls: false };
    if (!/^(?:gpt-[56]|o[134])(?:[.-]|$)/i.test(config.model)) body.temperature = config.temperature;
  } else if (protocol === 'anthropic_messages') {
    body = { model: config.model, ...anthropicInput(messages, config), max_tokens: config.maxOutputTokens ?? 4096, ...thinking,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })), tool_choice: { type: 'auto', disable_parallel_tool_use: true } };
  } else {
    body = { model: config.model, messages: chatMessages(messages), temperature: config.temperature, ...thinking,
      max_completion_tokens: config.maxOutputTokens ?? 4096, tools: tools.map((t) => ({ type: 'function', function: t })), tool_choice: listen ? 'auto' : 'required' };
  }
  const request = { endpoint: apiUrl(config.baseUrl, protocol), body, binding: protocolBinding(config), timeoutSec: config.timeoutSec };
  validateWire(request);
  return request;
}

export interface Target {
  id: string;
  model: string;
  protocol: ApiProtocol;
  mode: 'frozen' | 'portable';
  request: ReplayWireRequest;
  apiKey: string | null;
}
export interface Trial {
  id: string;
  targetId: string;
  variant: 'original' | 'candidate';
  repeat: number;
  requestHash: string;
  output: ReplayOutput;
}
export interface Run {
  version: 1;
  caseHash: string;
  synthetic: boolean;
  createdAt: string;
  seed: number;
  repeats: number;
  planned: number;
  targets: { id: string; model: string; protocol: ApiProtocol; mode: Target['mode']; endpoint: string; request: ReplayWireRequest; originalHash: string; candidateRequest?: ReplayWireRequest; candidateHash?: string }[];
  candidate?: { text: string; hash: string; originals: { targetId: string; text: string }[] };
  trials: Trial[];
  complete: boolean;
}

export function planRun(frozen: FrozenCase, targets: Target[], repeats: number, candidate: string | undefined, seed = 1): { run: Run; jobs: { target: Target; variant: Trial['variant']; repeat: number; request: ReplayWireRequest; id: string }[] } {
  verifyCase(frozen);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100 || !targets.length || targets.length > 8 || new Set(targets.map((t) => t.id)).size !== targets.length) throw Error('PLAN_INVALID: 需要 1–8 个独立模型、1–100 次重复');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('SEED_INVALID');
  if (candidate !== undefined && !candidate.trim()) throw Error('CANDIDATE_EMPTY');
  const jobs: { target: Target; variant: Trial['variant']; repeat: number; request: ReplayWireRequest; id: string }[] = [];
  const originals: { targetId: string; text: string }[] = [];
  const descriptions = targets.map((target) => {
    validateWire(target.request);
    const changed = structuredClone(target.request);
    if (candidate !== undefined) {
      const text = systemText(changed, target.protocol, candidate);
      if (text === candidate) throw Error('CANDIDATE_UNCHANGED: 候选与原系统块相同');
      originals.push({ targetId: target.id, text });
    }
    for (let repeat = 1; repeat <= repeats; repeat++) for (const variant of candidate === undefined ? ['original'] as const : ['original', 'candidate'] as const) {
      jobs.push({ target, variant, repeat, request: structuredClone(variant === 'original' ? target.request : changed), id: `${target.id}:${variant}:${repeat}` });
    }
    return { id: target.id, model: target.model, protocol: target.protocol, mode: target.mode, endpoint: target.request.endpoint, request: structuredClone(target.request), originalHash: digest(target.request), ...(candidate === undefined ? {} : { candidateRequest: changed, candidateHash: digest(changed) }) };
  });
  // Seeded shuffle changes execution order, never message order or request contents.
  let state = seed >>> 0;
  for (let i = jobs.length - 1; i > 0; i--) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; const j = state % (i + 1); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
  return { run: { version: 1, caseHash: frozen.caseHash, synthetic: frozen.synthetic, createdAt: new Date().toISOString(), seed, repeats, planned: jobs.length, targets: descriptions,
    ...(candidate === undefined ? {} : { candidate: { text: candidate, hash: digest(candidate), originals } }), trials: [], complete: false }, jobs };
}

export async function executePlan(plan: ReturnType<typeof planRun>, save: (run: Run) => void, execute = replayRequest): Promise<Run> {
  save(plan.run);
  for (const job of plan.jobs) {
    const output = await execute(structuredClone(job.request), job.target.protocol, job.target.apiKey);
    plan.run.trials.push({ id: job.id, targetId: job.target.id, variant: job.variant, repeat: job.repeat, requestHash: digest(job.request), output });
    save(plan.run);
  }
  plan.run.complete = true;
  save(plan.run);
  return plan.run;
}

export type Verdict = 'target_error' | 'other_error' | 'pass' | 'uncertain';
export interface Labels { runHash: string; labels: { trialId: string; verdict: Verdict; evidence: string[] }[] }

export const reviewId = (run: Run, trialId: string): string => `item-${digest([digest(run), trialId]).slice(0, 16)}`;

export function blindReview(run: Run) {
  return { runHash: digest(run), records: run.trials.map((t) => ({ trialId: reviewId(run, t.id), output: { status: t.output.status, failureKind: t.output.failureKind, text: t.output.text, calls: t.output.calls } })) };
}

export function labelTemplate(run: Run): Labels {
  return { runHash: digest(run), labels: run.trials.map((t) => ({ trialId: reviewId(run, t.id), verdict: 'uncertain', evidence: ['尚未人工判定；不能算通过。'] })) };
}

export function report(frozen: FrozenCase, run: Run, labels?: Labels): string {
  verifyCase(frozen);
  if (run.version !== 1 || run.caseHash !== frozen.caseHash || !Array.isArray(run.trials) || !Array.isArray(run.targets)) throw Error('REPORT_CASE_MISMATCH');
  if (run.targets.some((t) => digest(t.request) !== t.originalHash || t.candidateRequest && digest(t.candidateRequest) !== t.candidateHash)) throw Error('RUN_INVALID: 计划请求已变化');
  const ids = new Set(run.trials.map((t) => t.id));
  if (ids.size !== run.trials.length || run.trials.some((t) => !run.targets.some((target) => target.id === t.targetId && t.requestHash === (t.variant === 'original' ? target.originalHash : target.candidateHash)))) throw Error('RUN_INVALID: 重复试验或请求哈希不符');
  if (labels && !Array.isArray(labels.labels)) throw Error('LABELS_INVALID');
  const supplied = (labels?.labels ?? []).map((label) => ({ ...label, trialId: run.trials.find((t) => t.id === label.trialId || reviewId(run, t.id) === label.trialId)?.id ?? label.trialId }));
  if (labels && (labels.runHash !== digest(run) || !Array.isArray(supplied) || new Set(supplied.map((l) => l.trialId)).size !== supplied.length || supplied.some((l) => !ids.has(l.trialId) || !['target_error', 'other_error', 'pass', 'uncertain'].includes(l.verdict) || !Array.isArray(l.evidence) || !l.evidence.length || !l.evidence.every(nonempty)))) throw Error('LABELS_INVALID: 标注须绑定本次运行、引用证据且不能重复');
  if (supplied.some((l) => l.verdict !== 'uncertain' && run.trials.find((t) => t.id === l.trialId)!.output.status !== 'completed')) throw Error('LABELS_FAILED_RESPONSE: 失败请求不能当作可判定的完整响应');
  const completedCount = run.trials.filter((t) => t.output.status === 'completed').length;
  const attempts = run.trials.reduce((sum, t) => sum + t.output.httpAttempts, 0);
  const lines = ['# 对局幻觉诊断报告', '', `案例：${frozen.caseId}；现场哈希：${frozen.caseHash}`, '', `来源：${frozen.synthetic ? '合成诊断' : '历史对局'}；输入完整性：${frozen.fidelity}；已记录试验 ${run.trials.length}/${run.planned}；完整响应 ${completedCount}；失败 ${run.trials.length - completedCount}；HTTP 请求 ${attempts}；运行${run.complete ? '已结束' : '未完成'}。`, '',
    `目标错误：${frozen.rubric.targetError}`, '', `合理输出范围：${frozen.rubric.expected}`, '', '依据：', '', ...frozen.rubric.evidence.map((e) => `- ${e}`), '', '排除情形：', '', ...frozen.rubric.exclusions.map((e) => `- ${e}`), '',
    '| 模型 / 模式 | 提示词 | 已调用 | 完成响应 | 目标错误 / 可判定 | 其他错误 | 未判定 | 请求失败 | 目标错误率及 95% Wilson 区间 |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const target of run.targets) for (const variant of run.candidate ? ['original', 'candidate'] as const : ['original'] as const) {
    const trials = run.trials.filter((t) => t.targetId === target.id && t.variant === variant);
    const completed = trials.filter((t) => t.output.status === 'completed');
    const judged = completed.map((t) => supplied.find((l) => l.trialId === t.id)?.verdict ?? 'uncertain');
    const errors = judged.filter((v) => v === 'target_error').length;
    const other = judged.filter((v) => v === 'other_error').length;
    const n = judged.filter((v) => v === 'pass' || v === 'target_error').length;
    const interval = wilson(errors, n);
    lines.push(`| ${target.model.replaceAll('|', '\\|')} / ${target.mode} | ${variant} | ${trials.length} | ${completed.length} | ${errors}/${n} | ${other} | ${judged.filter((v) => v === 'uncertain').length} | ${trials.length - completed.length} | ${interval} |`);
  }
  lines.push('', '结论：以上只描述此冻结上文的重放。单次或少量重复不能证明提示词有效、模型整体幻觉率或根因。自动统计不代替规则核对；尚未标注的响应和失败请求不算通过。', '',
    '目标错误率仅以 pass 和 target_error 为分母。other_error 表示其他已确认错误但未完成目标事实判定，不能当作目标幻觉未发生；它与 uncertain、请求失败分别保留。若同时有明确目标错误和其他错误，标为 target_error 并在证据中说明其他错误。', '',
    '本报告没有自动归因或自动采纳候选提示词。agent 需逐项核对用户预期、本局配置、引擎执行及实际输入，再说明规则、实现链路、提示表达、模型表现或证据不足；多种原因可以并存。', '',
    '## 试验记录与标注', '', '| 试验 | 状态 | 判定 | 证据 / 失败类型 |', '| --- | --- | --- | --- |');
  for (const t of run.trials) {
    const label = supplied.find((l) => l.trialId === t.id);
    lines.push(`| ${t.id} | ${t.output.status} | ${t.output.status === 'completed' ? label?.verdict ?? 'uncertain' : '不计入可判定响应'} | ${(t.output.status === 'failed' ? t.output.failureKind ?? 'failed' : label?.evidence.join('；') ?? '尚未标注').replaceAll('|', '\\|').replaceAll('\n', ' ')} |`);
  }
  if (run.candidate) lines.push('', '## 候选提示词', '', `候选系统块哈希：${run.candidate.hash}。原系统块与完整请求保存在 run.json 的 candidate.originals 和 targets 字段，可逐项核对其余输入是否一致。`, '', '```text', run.candidate.text, '```');
  lines.push('', '## 输入与比较范围', '', ...frozen.notes.map((n) => `- ${n}`), '- frozen：使用保存的编码请求；仍受服务端模型版本、随机性和服务状态变化影响。', '- portable：重新编码语义消息与工具 Schema，去掉原生续接数据；不能称为历史原请求复现。', '- candidate 只替换第一个系统块，保留历史助手消息；只检验当前节点，不检验完整轨迹。', '- 原始故障回复保存在现场的 original 字段，未加入被测请求。', '');
  return lines.join('\n');
}

function wilson(errors: number, n: number): string {
  if (!n) return '不可估计';
  const p = errors / n, z = 1.96, d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return `${(100 * p).toFixed(1)}% [${(100 * (center - half)).toFixed(1)}%, ${(100 * (center + half)).toFixed(1)}%]`;
}
