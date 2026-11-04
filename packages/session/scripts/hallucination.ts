import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditEntry } from '@werewolf/protocol';
import { protocolBinding, type AdapterConfig } from '@werewolf/llm';
import { ModelLibrary } from '../src/model-library';
import { SecretBox } from '../src/secret';
import { assertCredentialRoute, blindReview, digest, executePlan, freezeAudit, labelTemplate, planRun, portableRequest, report, systemText, verifyCase, type FrozenCase, type Labels, type Run, type Rubric, type Target } from '../src/diagnostics/hallucination';
import { exampleCandidate, exampleCase } from '../src/diagnostics/hallucination-example';
import type { ReplayOutput, ReplayWireRequest } from '../src/diagnostics/replay-transport';

const read = <T>(path: string): T => JSON.parse(readFileSync(resolve(path), 'utf8')) as T;
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); };
function saveRun(path: string, run: Run) { const temp = `${path}.tmp`; writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, path); }
function args(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || options.has(match[1])) throw Error('ARGUMENT_INVALID: 使用 --参数=值，不要重复参数');
    options.set(match[1], match[2] ?? 'true');
  }
  return options;
}
function check(options: Map<string, string>, allowed: string[]) { for (const key of options.keys()) if (!allowed.includes(key)) throw Error(`ARGUMENT_UNKNOWN: --${key}`); }
function required(options: Map<string, string>, key: string): string { const value = options.get(key); if (!value || value === 'true') throw Error(`ARGUMENT_MISSING: --${key}=值`); return value; }
function integer(options: Map<string, string>, key: string, fallback: number): number { const raw = options.get(key); if (raw !== undefined && !/^\d+$/.test(raw)) throw Error(`ARGUMENT_INVALID: --${key} 需要非负整数`); return raw === undefined ? fallback : Number(raw); }
function readCase(path: string): FrozenCase { const frozen: unknown = read(path); verifyCase(frozen); return frozen; }
function freshDirectory(path: string): string { const directory = resolve(path); mkdirSync(dirname(directory), { recursive: true }); mkdirSync(directory); return directory; }
function modelLibrary(dataDir: string): ModelLibrary {
  if (!existsSync(join(dataDir, 'models.json')) || !process.env.WEREWOLF_SECRET && !existsSync(join(dataDir, 'secret.key'))) throw Error('MODEL_LIBRARY_MISSING: 指定已有项目模型库及主密钥目录；不会新建配置');
  return new ModelLibrary(SecretBox.fromEnvOrFile(dataDir), join(dataDir, 'models.json'));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command = 'help', ...rest] = argv;
  const options = args(rest);
  if (command === 'help') {
    console.log('hallucination: freeze | replay | compare | report | example | demo | models\n先读 skills/werewolf-hallucination/SKILL.md；所有输出目录必须新建，真实外发须显式 --live。'); return;
  }
  if (command === 'models') {
    check(options, ['data-dir']);
    const library = modelLibrary(resolve(options.get('data-dir') ?? 'data'));
    console.log(JSON.stringify(library.list().filter((m) => m.lifecycle === 'active' && !m.mergedInto).map((m) => ({ id: m.id, model: m.model, label: m.label, protocol: m.apiProtocol, provider: new URL(m.baseUrl).hostname, hasKey: !!m.apiKey })), null, 2)); return;
  }
  if (command === 'freeze') {
    check(options, ['audit-file', 'audit', 'room', 'case-id', 'rubric', 'request', 'output']);
    const id = integer(options, 'audit', 0);
    if (!id) throw Error('ARGUMENT_MISSING: --audit=正整数');
    const audits = readFileSync(resolve(required(options, 'audit-file')), 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as AuditEntry);
    const selected = audits.filter((a) => a.id === id);
    if (selected.length !== 1) throw Error('AUDIT_NOT_UNIQUE: 记录缺失或 ID 重复，先核对审计文件');
    const frozen = freezeAudit(selected[0], { roomId: required(options, 'room'), caseId: required(options, 'case-id'), rubric: read<Rubric>(required(options, 'rubric')),
      ...(options.has('request') ? { reconstructed: read<ReplayWireRequest>(required(options, 'request')) } : {}) });
    const directory = freshDirectory(required(options, 'output'));
    write(join(directory, 'case.json'), frozen);
    if (frozen.request) writeFileSync(join(directory, 'original-system.txt'), systemText(structuredClone(frozen.request), frozen.apiProtocol), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ output: directory, caseHash: frozen.caseHash, fidelity: frozen.fidelity, ready: !!frozen.request })); return;
  }
  if (command === 'example' || command === 'demo') {
    check(options, ['output']);
    const directory = freshDirectory(required(options, 'output'));
    const frozen = exampleCase();
    write(join(directory, 'case.json'), frozen);
    writeFileSync(join(directory, 'original-system.txt'), systemText(structuredClone(frozen.request!), frozen.apiProtocol), { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'candidate.txt'), exampleCandidate, { flag: 'wx', mode: 0o600 });
    if (command === 'demo') {
      const target: Target = { id: 'scripted-fixture', model: 'scripted-fixture', protocol: frozen.apiProtocol, mode: 'frozen', request: frozen.request!, apiKey: null };
      const plan = planRun(frozen, [target], 2, exampleCandidate, 7);
      let count = 0;
      const values: ReplayOutput[] = [
        { status: 'completed', text: '', calls: [{ id: 'c1', name: 'record_facts', arguments: '{"seat":2,"result":"good","night":2}' }], httpAttempts: 0, latencyMs: 0 },
        { status: 'failed', failureKind: 'timeout', text: '', calls: [], httpAttempts: 0, latencyMs: 0 },
        { status: 'completed', text: '', calls: [{ id: 'c3', name: 'record_facts', arguments: '{"seat":1,"result":"werewolf","night":1}' }], httpAttempts: 0, latencyMs: 0 },
        { status: 'completed', text: '无法确定', calls: [], httpAttempts: 0, latencyMs: 0 },
      ];
      const run = await executePlan(plan, (r) => saveRun(join(directory, 'run.json'), r), async () => structuredClone(values[count++]));
      const labels: Labels = { runHash: digest(run), labels: run.trials.map((t, i) => ({ trialId: t.id, verdict: (['target_error', 'uncertain', 'pass', 'other_error'] as const)[i], evidence: ['脚本化夹具：核对本条 output.calls；不代表模型表现。'] })) };
      write(join(directory, 'labels.json'), labels);
      writeFileSync(join(directory, 'report.md'), report(frozen, run, labels), { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify({ output: directory, synthetic: true, networkCalls: 0, ...(command === 'demo' ? { report: join(directory, 'report.md'), scripted: true } : {}) })); return;
  }
  if (command === 'report') {
    check(options, ['case', 'run', 'labels', 'analysis', 'output']);
    const frozen = readCase(required(options, 'case'));
    const run = read<Run>(required(options, 'run'));
    const labels = options.has('labels') ? read<Labels>(required(options, 'labels')) : undefined;
    const output = resolve(required(options, 'output'));
    mkdirSync(dirname(output), { recursive: true });
    const analysis = options.has('analysis') ? `\n## 证据核对与处理结论\n\n${readFileSync(resolve(required(options, 'analysis')), 'utf8')}\n` : '';
    writeFileSync(output, report(frozen, run, labels) + analysis, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ report: output, labeled: !!labels })); return;
  }
  if (command !== 'replay' && command !== 'compare') throw Error('COMMAND_UNKNOWN');
  check(options, ['case', 'models', 'candidate', 'repeats', 'seed', 'portable', 'live', 'data-dir', 'output', 'timeout', 'max-output-tokens']);
  const frozen = readCase(required(options, 'case'));
  if (!frozen.request) throw Error('REQUEST_MISSING: 旧审计没有编码请求，停止外发；按指南补齐重建文件');
  const ids = required(options, 'models').split(',');
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) throw Error('MODEL_SELECTION_INVALID');
  if (command === 'replay' && (ids.length !== 1 || options.has('candidate') || options.has('repeats'))) throw Error('REPLAY_SINGLE_ONLY: replay 恰好一次；重复和对照请用 compare');
  if (command === 'compare' && !options.has('candidate')) throw Error('CANDIDATE_MISSING');
  for (const key of ['portable', 'live']) if (options.has(key) && options.get(key) !== 'true') throw Error(`ARGUMENT_INVALID: --${key} 不接受值`);
  if (!options.has('portable') && (options.has('timeout') || options.has('max-output-tokens'))) throw Error('FROZEN_PARAMETERS_FIXED: 原请求参数不能覆盖；改参数必须显式 --portable');
  const library = modelLibrary(resolve(options.get('data-dir') ?? 'data'));
  const targets: Target[] = ids.map((id) => {
    const model = library.findRaw(id);
    if (!model || model.lifecycle !== 'active' || model.mergedInto || !model.apiKey) throw Error(`MODEL_UNAVAILABLE: ${id}`);
    const config: AdapterConfig = { apiProtocol: model.apiProtocol, model: model.model, baseUrl: model.baseUrl, apiKey: model.apiKey, temperature: 0.7, toolMode: 'tools', timeoutSec: integer(options, 'timeout', 90), thinkingMode: 'default', maxOutputTokens: integer(options, 'max-output-tokens', 4096) };
    if (config.maxOutputTokens! < 1 || config.maxOutputTokens! > 32768) throw Error('OUTPUT_LIMIT_INVALID');
    const portable = options.has('portable');
    if (!portable && (model.apiProtocol !== frozen.apiProtocol || protocolBinding(config) !== frozen.request!.binding || model.model !== frozen.request!.body.model)) throw Error('BINDING_MISMATCH: 端点、模型、协议或凭证已变化；跨模型请显式 --portable');
    const request = portable ? portableRequest(frozen, config) : structuredClone(frozen.request!);
    assertCredentialRoute(request, config);
    return { id, model: model.model, protocol: model.apiProtocol, mode: portable ? 'portable' : 'frozen', request, apiKey: model.apiKey };
  });
  const candidate = command === 'compare' ? readFileSync(resolve(required(options, 'candidate')), 'utf8') : undefined;
  const plan = planRun(frozen, targets, command === 'replay' ? 1 : integer(options, 'repeats', 3), candidate, integer(options, 'seed', 1));
  const directory = freshDirectory(required(options, 'output'));
  write(join(directory, 'plan.json'), { ...plan.run, liveRequested: options.has('live') });
  if (!options.has('live')) { console.log(JSON.stringify({ dryRun: true, planned: plan.run.planned, output: directory, next: '核对 plan.json 与授权后，用新输出目录添加 --live；当前未外发。' })); return; }
  const run = await executePlan(plan, (r) => { saveRun(join(directory, 'run.json'), r); console.log(JSON.stringify({ completed: r.trials.length, planned: r.planned })); });
  write(join(directory, 'labels.json'), labelTemplate(run));
  write(join(directory, 'blind-review.json'), { caseHash: frozen.caseHash, rubric: frozen.rubric, ...blindReview(run) });
  writeFileSync(join(directory, 'report-unreviewed.md'), report(frozen, run), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: directory, completed: run.trials.length, planned: run.planned, next: '先按判定卡阅读 blind-review.json 并编辑 labels.json；完成标注后再查看 run.json，运行 report。' }));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
