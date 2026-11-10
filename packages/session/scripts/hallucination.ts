import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AuditEntry, ToolSpec } from '@werewolf/protocol';
import { apiUrl } from '@werewolf/protocol';
import { ModelLibrary } from '../src/model-library';
import { SecretBox } from '../src/secret';
import { blindReview, digest, executePlan, freezeAudit, improvementSummary, labelTemplate, planRun, report, verifyCase, type FrozenCase, type Job, type Labels, type Rubric, type Run, type Target, type TrialOutput } from '../src/diagnostics/hallucination';
import { exampleCandidate, exampleCase, exampleTools } from '../src/diagnostics/hallucination-example';

const read = <T>(path: string): T => JSON.parse(readFileSync(resolve(path), 'utf8')) as T;
const writeNew = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); };
const saveRun = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); };
function args(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (const arg of argv) { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg); if (!m || out.has(m[1])) throw Error('ARGUMENT_INVALID: 使用 --参数=值，不要重复参数'); out.set(m[1], m[2] ?? 'true'); } return out; }
function check(options: Map<string, string>, allowed: string[]) { for (const key of options.keys()) if (!allowed.includes(key)) throw Error(`ARGUMENT_UNKNOWN: --${key}`); }
function required(options: Map<string, string>, key: string): string { const value = options.get(key); if (!value || value === 'true') throw Error(`ARGUMENT_MISSING: --${key}=值`); return value; }
function integer(options: Map<string, string>, key: string, fallback: number): number { const raw = options.get(key); if (raw !== undefined && !/^\d+$/.test(raw)) throw Error(`ARGUMENT_INVALID: --${key} 需要非负整数`); return raw === undefined ? fallback : Number(raw); }
function freshDirectory(path: string): string { const directory = resolve(path); mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory); return directory; }
function readCase(path: string): FrozenCase { const value: unknown = read(path); verifyCase(value); return value; }
function modelLibrary(dataDir: string): ModelLibrary { if (!existsSync(join(dataDir, 'models.json')) || (!process.env.WEREWOLF_SECRET && !existsSync(join(dataDir, 'secret.key')))) throw Error('MODEL_LIBRARY_MISSING: 指定已有项目模型库及主密钥目录；不会新建配置'); return new ModelLibrary(SecretBox.fromEnvOrFile(dataDir), join(dataDir, 'models.json')); }

function pythonRequest(frozen: FrozenCase, job: Job): Promise<TrialOutput> {
  const script = resolve('packages/session/scripts/hallucination_request.py');
  const request = { protocol: job.target.protocol, endpoint: apiUrl(job.target.config.baseUrl, job.target.protocol), api_key: job.target.config.apiKey, model: job.target.config.model, messages: job.messages, tools: frozen.tools, tool_choice: frozen.source.purpose === 'listen' ? 'auto' : 'required', temperature: job.target.config.temperature, timeout: job.target.config.timeoutSec, max_output_tokens: job.target.config.maxOutputTokens ?? 4096 };
  return new Promise((resolveResult) => {
    const started = Date.now(); const child = spawn(process.env.PYTHON ?? 'python', [script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); let stdout = ''; let settled = false;
    const finish = (output: TrialOutput) => { if (settled) return; settled = true; clearTimeout(timer); resolveResult({ ...output, latencyMs: output.latencyMs || Date.now() - started }); };
    const timer = setTimeout(() => { child.kill(); finish({ status: 'failed', failureKind: 'timeout', error: 'Request timed out', text: '', latencyMs: Date.now() - started }); }, Math.max(1000, job.target.config.timeoutSec * 1000 + 1000));
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', () => finish({ status: 'failed', failureKind: 'network', error: 'Python request runner unavailable', text: '', latencyMs: Date.now() - started }));
    child.on('close', () => { try { const output = JSON.parse(stdout) as TrialOutput; finish(output); } catch { finish({ status: 'failed', failureKind: 'network', error: 'Python request runner returned invalid JSON', text: '', latencyMs: Date.now() - started }); } });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command = 'help', ...rest] = argv; const options = args(rest);
  if (command === 'help') { console.log('hallucination: freeze | run | compare | summary | report | example | demo | models\n流程只处理语义 messages 和工具定义；真实外发须显式 --live。'); return; }
  if (command === 'models') { check(options, ['data-dir']); const library = modelLibrary(resolve(options.get('data-dir') ?? 'data')); console.log(JSON.stringify(library.list().filter((m) => m.lifecycle === 'active' && !m.mergedInto).map((m) => ({ id: m.id, model: m.model, label: m.label, protocol: m.apiProtocol, provider: new URL(m.baseUrl).hostname, hasKey: !!m.apiKey })), null, 2)); return; }
  if (command === 'freeze') {
    check(options, ['audit-file', 'audit', 'room', 'case-id', 'rubric', 'tools-file', 'output']); const id = integer(options, 'audit', 0); if (!id) throw Error('ARGUMENT_MISSING: --audit=正整数'); const audits = readFileSync(resolve(required(options, 'audit-file')), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AuditEntry); const selected = audits.filter((a) => a.id === id); if (selected.length !== 1) throw Error('AUDIT_NOT_UNIQUE: 记录缺失或 ID 重复'); const frozen = freezeAudit(selected[0], { roomId: required(options, 'room'), caseId: required(options, 'case-id'), rubric: read<Rubric>(required(options, 'rubric')), ...(options.has('tools-file') ? { tools: read<ToolSpec[]>(required(options, 'tools-file')) } : {}) }); const directory = freshDirectory(required(options, 'output')); writeNew(join(directory, 'case.json'), frozen); writeNew(join(directory, 'messages.json'), frozen.messages); writeNew(join(directory, 'tools.json'), frozen.tools); console.log(JSON.stringify({ output: directory, caseHash: frozen.caseHash, fidelity: frozen.fidelity, ready: frozen.tools.length > 0 })); return;
  }
  if (command === 'example' || command === 'demo') {
    check(options, ['output']); const directory = freshDirectory(required(options, 'output')); const frozen = exampleCase(); writeNew(join(directory, 'case.json'), frozen); writeNew(join(directory, 'messages.json'), frozen.messages); writeNew(join(directory, 'tools.json'), exampleTools); writeFileSync(join(directory, 'candidate.txt'), `${exampleCandidate}\n`, { flag: 'wx', mode: 0o600 });
    if (command === 'demo') { const target: Target = { id: 'scripted-fixture', model: 'scripted-fixture', protocol: 'chat_completions', config: { apiProtocol: 'chat_completions', baseUrl: 'http://fixture.invalid/v1', model: 'scripted-fixture', apiKey: null, temperature: 0, toolMode: 'tools', timeoutSec: 1 } }; const plan = planRun(frozen, [target], 2, exampleCandidate, 7); const values: TrialOutput[] = [{ status: 'completed', text: '', call: { tool: 'record_facts', args: { seat: 2, result: 'good', night: '2' } }, latencyMs: 0 }, { status: 'failed', failureKind: 'timeout', error: 'fixture timeout', text: '', latencyMs: 0 }, { status: 'completed', text: '', call: { tool: 'record_facts', args: { seat: 1, result: 'werewolf', night: '1' } }, latencyMs: 0 }, { status: 'completed', text: '无法确定', latencyMs: 0 }]; let index = 0; const run = await executePlan(plan, frozen, (value) => saveRun(join(directory, 'run.json'), value), async () => structuredClone(values[index++])); const labels: Labels = { runHash: digest(run), labels: run.trials.map((t, i) => ({ trialId: t.id, verdict: (['target_error', 'uncertain', 'pass', 'other_error'] as const)[i], evidence: ['脚本化夹具：核对本条 output；不代表模型表现。'] })) }; writeNew(join(directory, 'labels.json'), labels); writeFileSync(join(directory, 'report.md'), report(frozen, run, labels), { flag: 'wx', mode: 0o600 }); }
    console.log(JSON.stringify({ output: directory, synthetic: true, networkCalls: 0, ...(command === 'demo' ? { report: join(directory, 'report.md'), scripted: true } : {}) })); return;
  }
  if (command === 'summary') { check(options, ['case', 'run', 'labels', 'output']); const frozen = readCase(required(options, 'case')); const run = read<Run>(required(options, 'run')); const labels = read<Labels>(required(options, 'labels')); const output = resolve(required(options, 'output')); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(improvementSummary(frozen, run, labels), null, 2)}\n`, { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify({ summary: output })); return; }
  if (command === 'report') { check(options, ['case', 'run', 'labels', 'analysis', 'output']); const frozen = readCase(required(options, 'case')); const run = read<Run>(required(options, 'run')); const labels = options.has('labels') ? read<Labels>(required(options, 'labels')) : undefined; const output = resolve(required(options, 'output')); mkdirSync(dirname(output), { recursive: true }); const analysis = options.has('analysis') ? `\n## 证据核对与处理结论\n\n${readFileSync(resolve(required(options, 'analysis')), 'utf8')}\n` : ''; writeFileSync(output, report(frozen, run, labels) + analysis, { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify({ report: output, labeled: !!labels })); return; }
  if (command !== 'run' && command !== 'compare') throw Error('COMMAND_UNKNOWN');
  check(options, ['case', 'models', 'candidate', 'repeats', 'seed', 'live', 'data-dir', 'output', 'timeout', 'max-output-tokens']); const frozen = readCase(required(options, 'case')); if (!frozen.tools.length) throw Error('TOOLS_MISSING: 先用 freeze --tools-file 提供该席的语义工具定义'); const ids = required(options, 'models').split(','); if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) throw Error('MODEL_SELECTION_INVALID'); if (command === 'compare' && !options.has('candidate')) throw Error('CANDIDATE_MISSING'); if (options.has('live') && options.get('live') !== 'true') throw Error('ARGUMENT_INVALID: --live 不接受值');
  const library = modelLibrary(resolve(options.get('data-dir') ?? 'data')); const targets = ids.map((id): Target => { const model = library.findRaw(id); if (!model || model.lifecycle !== 'active' || model.mergedInto || !model.apiKey) throw Error(`MODEL_UNAVAILABLE: ${id}`); return { id, model: model.model, protocol: model.apiProtocol, config: { apiProtocol: model.apiProtocol, baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey, temperature: 0.7, toolMode: 'tools', timeoutSec: integer(options, 'timeout', 90), thinkingMode: 'default', maxOutputTokens: integer(options, 'max-output-tokens', 4096) } }; });
  const candidate = command === 'compare' ? readFileSync(resolve(required(options, 'candidate')), 'utf8') : undefined; const plan = planRun(frozen, targets, command === 'run' ? integer(options, 'repeats', 1) : integer(options, 'repeats', 3), candidate, integer(options, 'seed', 1)); const directory = freshDirectory(required(options, 'output')); writeNew(join(directory, 'plan.json'), { ...plan.run, liveRequested: options.has('live') }); if (!options.has('live')) { console.log(JSON.stringify({ dryRun: true, planned: plan.run.planned, output: directory, next: '核对 plan.json 后，在新目录加 --live；当前未外发。' })); return; }
  const trialJournal = join(directory, 'trial-records.jsonl'); writeFileSync(trialJournal, '', { flag: 'wx', mode: 0o600 }); let recorded = 0;
  const save = (value: Run) => {
    saveRun(join(directory, 'run.json'), value);
    while (recorded < value.trials.length) {
      const trial = value.trials[recorded++];
      appendFileSync(trialJournal, `${JSON.stringify({ recordedAt: new Date().toISOString(), caseHash: frozen.caseHash, trial, reviewStatus: 'pending' })}\n`, { encoding: 'utf8' });
    }
    console.log(JSON.stringify({ completed: value.trials.length, planned: value.planned, recorded }));
  };
  const run = await executePlan(plan, frozen, save, pythonRequest); const labels = labelTemplate(run); writeNew(join(directory, 'labels.json'), labels); writeNew(join(directory, 'blind-review.json'), { caseHash: frozen.caseHash, rubric: frozen.rubric, ...blindReview(run) }); writeNew(join(directory, 'improvement.json'), improvementSummary(frozen, run, labels)); writeFileSync(join(directory, 'report-unreviewed.md'), report(frozen, run), { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify({ output: directory, completed: run.trials.length, planned: run.planned, recorded, next: '先阅读 trial-records.jsonl 和 blind-review.json，更新 labels.json 后运行 summary 与 report。' }));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
