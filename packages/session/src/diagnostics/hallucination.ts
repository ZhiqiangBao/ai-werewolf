import { createHash } from 'node:crypto';
import type { AuditEntry, ApiProtocol, ToolSpec } from '@werewolf/protocol';
import type { AdapterConfig, TranscriptMessage } from '@werewolf/llm';
import { migrateTranscript } from '@werewolf/llm';

export interface Rubric { targetError: string; expected: string; evidence: string[]; exclusions: string[] }
export interface FrozenCase {
  version: 2; caseId: string; synthetic: boolean; createdAt: string;
  source: { roomId: string; auditId: number; seat: number; decisionId: string; projectionVersion: number; at: number; model: string; protocol?: ApiProtocol; purpose?: 'listen' | 'action'; attempt?: number };
  fidelity: 'captured' | 'incomplete'; notes: string[]; messages: TranscriptMessage[]; tools: ToolSpec[];
  original: { response?: unknown; toolCall?: unknown; error?: string }; rubric: Rubric; caseHash: string;
}
export interface Target { id: string; model: string; protocol: ApiProtocol; config: AdapterConfig }
export interface TrialOutput { status: 'completed' | 'failed'; text: string; call?: { tool: string; args: Record<string, unknown> }; failureKind?: string; error?: string; latencyMs: number }
export interface Trial { id: string; targetId: string; variant: 'original' | 'candidate'; repeat: number; inputHash: string; output: TrialOutput }
export interface Run { version: 2; caseHash: string; synthetic: boolean; createdAt: string; seed: number; repeats: number; planned: number; targets: { id: string; model: string; protocol: ApiProtocol }[]; candidate?: { text: string; hash: string }; trials: Trial[]; complete: boolean }
export interface Job { target: Target; variant: Trial['variant']; repeat: number; messages: TranscriptMessage[]; id: string }

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])); return value; }
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function validateRubric(rubric: Rubric): void { if (!object(rubric) || !nonempty(rubric.targetError) || !nonempty(rubric.expected) || !Array.isArray(rubric.evidence) || !rubric.evidence.length || !rubric.evidence.every(nonempty) || !Array.isArray(rubric.exclusions) || !rubric.exclusions.every(nonempty)) throw Error('RUBRIC_INVALID: 请填写目标错误、期望、证据和排除情形'); }
function semanticMessages(messages: unknown): TranscriptMessage[] { const migrated = migrateTranscript(messages as any[]); if (!migrated.length || migrated.some((m) => !object(m) || !['system', 'user', 'assistant', 'tool'].includes(m.role) || !(typeof m.content === 'string' || m.role === 'assistant' && m.content === null))) throw Error('MESSAGES_MISSING: 审计没有完整语义消息'); return migrated.map((m) => m.role === 'assistant' ? { role: 'assistant', content: m.content, ...(m.calls ? { calls: structuredClone(m.calls) } : {}) } : structuredClone(m)); }
function validTools(tools: unknown): tools is ToolSpec[] { return Array.isArray(tools) && tools.every((tool) => object(tool) && nonempty(tool.name) && nonempty(tool.title) && nonempty(tool.description) && Array.isArray(tool.params)); }

export function freezeAudit(audit: AuditEntry, options: { roomId: string; caseId: string; rubric: Rubric; tools?: ToolSpec[]; synthetic?: boolean }): FrozenCase {
  validateRubric(options.rubric); const messages = semanticMessages(audit.messages); const tools = options.tools ?? [];
  if (!validTools(tools)) throw Error('TOOLS_INVALID: 工具定义必须来自该席实际投影');
  if (!Number.isSafeInteger(audit.id) || audit.id < 1 || !Number.isSafeInteger(audit.seat) || audit.seat < 1 || !nonempty(options.caseId) || !nonempty(options.roomId)) throw Error('SOURCE_INVALID: 需要明确的房间、审计和座位');
  const notes = ['冻结的是模型可见的语义消息和工具定义；不保存或重放 HTTP 请求、原生续接或隐藏推理。', '原始响应只作为证据保存，不会加入后续测试上下文。'];
  if (!tools.length) notes.push('缺少该次调用的工具定义；可以做文本上下文检查，不能可靠评估工具参数。');
  if (options.synthetic) notes.push('合成诊断案例，不是真实对局故障。');
  const payload: Omit<FrozenCase, 'caseHash'> = { version: 2, caseId: options.caseId, synthetic: !!options.synthetic, createdAt: new Date().toISOString(), source: { roomId: options.roomId, auditId: audit.id, seat: audit.seat, decisionId: audit.decisionId, projectionVersion: audit.projectionVersion, at: audit.at, model: audit.model, ...(audit.apiProtocol ? { protocol: audit.apiProtocol } : {}), ...(audit.purpose ? { purpose: audit.purpose } : {}), ...(audit.attempt ? { attempt: audit.attempt } : {}) }, fidelity: tools.length ? 'captured' : 'incomplete', notes, messages, tools: structuredClone(tools), original: { response: audit.response, toolCall: audit.toolCall, error: audit.error }, rubric: structuredClone(options.rubric) };
  const saved = JSON.parse(JSON.stringify(payload)) as Omit<FrozenCase, 'caseHash'>; return { ...saved, caseHash: digest(saved) };
}
export function verifyCase(value: unknown): asserts value is FrozenCase { if (!object(value) || value.version !== 2 || !nonempty(value.caseHash)) throw Error('CASE_INVALID: 不支持的语义现场文件'); const { caseHash, ...payload } = value; if (digest(payload) !== caseHash) throw Error('CASE_HASH_MISMATCH: 现场已变化，请重新冻结'); validateRubric(value.rubric); semanticMessages(value.messages); if (!['captured', 'incomplete'].includes(value.fidelity) || !object(value.source) || !validTools(value.tools)) throw Error('CASE_INVALID: 缺少来源或工具定义'); }
export function systemText(messages: TranscriptMessage[], replacement?: string): string { const system = messages.find((message) => message.role === 'system'); if (!system) throw Error('SYSTEM_NOT_FOUND: 现场没有 system message'); const original = system.content; if (replacement !== undefined) system.content = replacement; return original; }

export function planRun(frozen: FrozenCase, targets: Target[], repeats: number, candidate: string | undefined, seed = 1): { run: Run; jobs: Job[] } {
  verifyCase(frozen); if (!targets.length || targets.length > 8 || new Set(targets.map((t) => t.id)).size !== targets.length) throw Error('PLAN_INVALID: 需要 1–8 个独立模型'); if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100 || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('PLAN_INVALID: 重复次数或随机种子无效'); if (candidate !== undefined && !candidate.trim()) throw Error('CANDIDATE_EMPTY');
  const jobs: Job[] = []; for (const target of targets) for (let repeat = 1; repeat <= repeats; repeat++) for (const variant of candidate === undefined ? ['original'] as const : ['original', 'candidate'] as const) { const messages = structuredClone(frozen.messages); if (variant === 'candidate') systemText(messages, candidate); jobs.push({ target, variant, repeat, messages, id: `${target.id}:${variant}:${repeat}` }); }
  let state = seed >>> 0; for (let i = jobs.length - 1; i > 0; i--) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; const j = state % (i + 1); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
  return { run: { version: 2, caseHash: frozen.caseHash, synthetic: frozen.synthetic, createdAt: new Date().toISOString(), seed, repeats, planned: jobs.length, targets: targets.map(({ id, model, protocol }) => ({ id, model, protocol })), ...(candidate === undefined ? {} : { candidate: { text: candidate, hash: digest(candidate) } }), trials: [], complete: false }, jobs };
}

export type SemanticExecutor = (frozen: FrozenCase, job: Job) => Promise<TrialOutput>;
export async function executePlan(plan: ReturnType<typeof planRun>, frozen: FrozenCase, save: (run: Run) => void, execute: SemanticExecutor): Promise<Run> { save(plan.run); for (const job of plan.jobs) { const output = await execute(frozen, job); plan.run.trials.push({ id: job.id, targetId: job.target.id, variant: job.variant, repeat: job.repeat, inputHash: digest({ messages: job.messages, tools: frozen.tools }), output }); save(plan.run); } plan.run.complete = true; save(plan.run); return plan.run; }

export type Verdict = 'target_error' | 'other_error' | 'pass' | 'uncertain';
export interface Labels { runHash: string; labels: { trialId: string; verdict: Verdict; evidence: string[] }[] }
export const reviewId = (run: Run, trialId: string): string => `item-${digest([digest(run), trialId]).slice(0, 16)}`;
export function blindReview(run: Run) { return { runHash: digest(run), records: run.trials.map((t) => ({ trialId: reviewId(run, t.id), output: structuredClone(t.output) })) }; }
export function labelTemplate(run: Run): Labels { return { runHash: digest(run), labels: run.trials.map((t) => ({ trialId: reviewId(run, t.id), verdict: 'uncertain', evidence: ['尚未人工判定；不能算通过。'] })) }; }

export function improvementSummary(frozen: FrozenCase, run: Run, labels: Labels): Record<string, unknown> {
  verifyCase(frozen);
  if (run.version !== 2 || run.caseHash !== frozen.caseHash || labels.runHash !== digest(run)) throw Error('SUMMARY_CASE_MISMATCH');
  const verdicts = new Map<string, Verdict>();
  for (const label of labels.labels) {
    const trial = run.trials.find((t) => t.id === label.trialId || reviewId(run, t.id) === label.trialId);
    if (trial) verdicts.set(trial.id, label.verdict);
  }
  const rows = run.targets.flatMap((target) => (run.candidate ? (['original', 'candidate'] as const) : (['original'] as const)).map((variant) => {
    const trials = run.trials.filter((t) => t.targetId === target.id && t.variant === variant);
    const completed = trials.filter((t) => t.output.status === 'completed');
    const judged = completed.map((t) => verdicts.get(t.id) ?? 'uncertain');
    const targetErrors = judged.filter((v) => v === 'target_error').length;
    const passes = judged.filter((v) => v === 'pass').length;
    const otherErrors = judged.filter((v) => v === 'other_error').length;
    const uncertain = judged.filter((v) => v === 'uncertain').length;
    const denominator = targetErrors + passes;
    return { targetId: target.id, model: target.model, protocol: target.protocol, variant, trials: trials.length, completed: completed.length, targetErrors, passes, otherErrors, uncertain, targetErrorRate: denominator ? targetErrors / denominator : null, passRate: denominator ? passes / denominator : null };
  }));
  const paired = run.targets.map((target) => {
    const original = rows.find((row) => row.targetId === target.id && row.variant === 'original');
    const candidate = rows.find((row) => row.targetId === target.id && row.variant === 'candidate');
    const originalRate = typeof original?.targetErrorRate === 'number' ? original.targetErrorRate : null;
    const candidateRate = typeof candidate?.targetErrorRate === 'number' ? candidate.targetErrorRate : null;
    return { targetId: target.id, model: target.model, originalTargetErrorRate: originalRate, candidateTargetErrorRate: candidateRate, candidateMinusOriginalTargetErrorRate: originalRate !== null && candidateRate !== null ? candidateRate - originalRate : null, originalPassRate: original?.passRate ?? null, candidatePassRate: candidate?.passRate ?? null };
  });
  return { version: 1, generatedAt: new Date().toISOString(), caseId: frozen.caseId, caseHash: frozen.caseHash, candidateHash: run.candidate?.hash ?? null, seed: run.seed, repeats: run.repeats, planned: run.planned, recorded: run.trials.length, complete: run.complete, rows, paired, note: '错误率分母只包含已人工标注为 pass 或 target_error 的完整响应；uncertain、失败和未记录结果不计入。' };
}

export function report(frozen: FrozenCase, run: Run, labels?: Labels): string {
  verifyCase(frozen); if (run.version !== 2 || run.caseHash !== frozen.caseHash || !Array.isArray(run.trials) || !Array.isArray(run.targets)) throw Error('REPORT_CASE_MISMATCH'); const ids = new Set(run.trials.map((t) => t.id)); if (ids.size !== run.trials.length || run.trials.some((t) => !run.targets.some((target) => target.id === t.targetId))) throw Error('RUN_INVALID: 试验记录不完整'); if (labels && (!Array.isArray(labels.labels) || labels.runHash !== digest(run))) throw Error('LABELS_INVALID: 标注必须绑定本次运行'); const supplied = (labels?.labels ?? []).map((label) => ({ ...label, trialId: run.trials.find((t) => t.id === label.trialId || reviewId(run, t.id) === label.trialId)?.id ?? label.trialId })); if (labels && (new Set(supplied.map((l) => l.trialId)).size !== supplied.length || supplied.some((l) => !ids.has(l.trialId) || !['target_error', 'other_error', 'pass', 'uncertain'].includes(l.verdict) || !Array.isArray(l.evidence) || !l.evidence.length || !l.evidence.every(nonempty)))) throw Error('LABELS_INVALID: 标注须引用具体证据且不能重复'); if (supplied.some((l) => l.verdict !== 'uncertain' && run.trials.find((t) => t.id === l.trialId)!.output.status !== 'completed')) throw Error('LABELS_FAILED_RESPONSE: 失败请求不能标为通过或错误');
  const completedCount = run.trials.filter((t) => t.output.status === 'completed').length; const lines = ['# 对局幻觉诊断报告', '', `案例：${frozen.caseId}；现场哈希：${frozen.caseHash}`, '', `来源：${frozen.synthetic ? '合成诊断' : '历史对局'}；现场完整性：${frozen.fidelity}；已记录试验 ${run.trials.length}/${run.planned}；完整响应 ${completedCount}；失败 ${run.trials.length - completedCount}；运行${run.complete ? '已结束' : '未完成'}。`, '', `目标错误：${frozen.rubric.targetError}`, '', `合理输出范围：${frozen.rubric.expected}`, '', '依据：', '', ...frozen.rubric.evidence.map((e) => `- ${e}`), '', '排除情形：', '', ...frozen.rubric.exclusions.map((e) => `- ${e}`), '', '| 模型 | 提示词 | 已调用 | 完整响应 | 目标错误 / 可判定 | 其他错误 | 未判定 | 请求失败 | 目标错误率及 95% Wilson 区间 |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const target of run.targets) for (const variant of run.candidate ? ['original', 'candidate'] as const : ['original'] as const) { const trials = run.trials.filter((t) => t.targetId === target.id && t.variant === variant); const completed = trials.filter((t) => t.output.status === 'completed'); const judged = completed.map((t) => supplied.find((l) => l.trialId === t.id)?.verdict ?? 'uncertain'); const errors = judged.filter((v) => v === 'target_error').length; const other = judged.filter((v) => v === 'other_error').length; const n = judged.filter((v) => v === 'pass' || v === 'target_error').length; lines.push(`| ${target.model.replaceAll('|', '\\|')} | ${variant} | ${trials.length} | ${completed.length} | ${errors}/${n} | ${other} | ${judged.filter((v) => v === 'uncertain').length} | ${trials.length - completed.length} | ${wilson(errors, n)} |`); }
  lines.push('', '结论：以上只描述这组冻结语义上下文。重复采样不能证明模型整体幻觉率、规则根因或提示词普遍有效；模型失败、格式错误和证据不足分别保留。', '', '本报告不自动归因或采纳候选提示词。需要继续核对用户预期、本局规则、引擎执行、消息来源和模型输入。', '', '## 试验记录与标注', '', '| 试验 | 状态 | 判定 | 证据 / 失败类型 |', '| --- | --- | --- | --- |');
  for (const t of run.trials) { const label = supplied.find((l) => l.trialId === t.id); lines.push(`| ${t.id} | ${t.output.status} | ${t.output.status === 'completed' ? label?.verdict ?? 'uncertain' : '不计入可判定响应'} | ${(t.output.status === 'failed' ? t.output.failureKind ?? 'failed' : label?.evidence.join('；') ?? '尚未标注').replaceAll('|', '\\|').replaceAll('\n', ' ')} |`); }
  lines.push('', '## 输入与比较范围', '', ...frozen.notes.map((n) => `- ${n}`), '- 所有模型接收同一份语义 messages 和工具定义；脚本只负责调用，不重放原始 HTTP 请求。', '- candidate 只替换第一条 system message，其他消息和工具定义保持不变。', '- 原始异常回复保存在 original 字段，没有加入被测上下文。'); return lines.join('\n');
}
function wilson(errors: number, n: number): string { if (!n) return '不可估计'; const p = errors / n, z = 1.96, d = 1 + z * z / n; const center = (p + z * z / (2 * n)) / d; const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return `${(100 * p).toFixed(1)}% [${(100 * (center - half)).toFixed(1)}%, ${(100 * (center + half)).toFixed(1)}%]`; }
