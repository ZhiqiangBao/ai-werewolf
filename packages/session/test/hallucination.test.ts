import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@werewolf/protocol';
import { protocolBinding } from '@werewolf/llm';
import { main } from '../scripts/hallucination';
import { ModelLibrary } from '../src/model-library';
import { SecretBox } from '../src/secret';
import { assertCredentialRoute, blindReview, digest, executePlan, freezeAudit, labelTemplate, planRun, portableRequest, report, systemText, verifyCase, type FrozenCase, type Labels, type Target } from '../src/diagnostics/hallucination';
import { exampleCandidate, exampleCase } from '../src/diagnostics/hallucination-example';
import type { ReplayOutput } from '../src/diagnostics/replay-transport';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temporary = () => { const base = resolve('data/diagnostics/hallucination'); mkdirSync(base, { recursive: true }); const directory = mkdtempSync(join(base, 'test-')); directories.push(directory); return directory; };
function target(frozen = exampleCase()): Target { return { id: 'model-a', model: 'synthetic-recorder', protocol: 'chat_completions', mode: 'frozen', request: structuredClone(frozen.request!), apiKey: 'credential-in-memory' }; }
const output = (status: ReplayOutput['status'] = 'completed'): ReplayOutput => ({ status, text: 'response', calls: [], latencyMs: 1, httpAttempts: 1, ...(status === 'failed' ? { failureKind: 'timeout' as const } : {}) });

describe('freeze the actual request without regenerating history', () => {
  it('keeps original failure outside the request and detects later edits', () => {
    const frozen = exampleCase();
    expect(JSON.stringify(frozen.request)).not.toContain('历史错误示例');
    expect(JSON.stringify(frozen.original)).toContain('历史错误示例');
    verifyCase(JSON.parse(JSON.stringify(frozen)));
    frozen.messages[1].content = 'tampered';
    expect(() => verifyCase(frozen)).toThrow('CASE_HASH_MISMATCH');
  });
  it('freezes legacy evidence as incomplete without borrowing current state', () => {
    const frozen = exampleCase();
    const audit: AuditEntry = { id: 8, at: 0, seat: 4, model: 'old', apiProtocol: 'chat_completions', decisionId: 'd', projectionVersion: 1, ok: true, messages: frozen.messages };
    const options = { roomId: 'r', caseId: 'c', rubric: frozen.rubric };
    const legacy = freezeAudit(audit, options);
    expect(legacy.fidelity).toBe('incomplete');
    expect(legacy.request).toBeUndefined();
    const captured = freezeAudit({ ...audit, request: { apiProtocol: 'chat_completions', tools: [], replay: frozen.request } }, options);
    expect(captured.fidelity).toBe('captured');
    expect(captured.messages).toEqual(frozen.messages);
    expect(() => freezeAudit({ ...audit, messages: undefined }, options)).toThrow('MESSAGES_MISSING');
  });
  it('rejects credential fields and unsafe routes in reconstruction', () => {
    const frozen = exampleCase();
    const audit = { id: 1, at: 0, seat: 4, model: 'old', apiProtocol: 'responses', decisionId: 'd', projectionVersion: 1, ok: true, messages: frozen.messages } as AuditEntry;
    const options = { roomId: 'r', caseId: 'c', rubric: frozen.rubric, reconstructed: { ...frozen.request!, headers: {} } };
    expect(() => freezeAudit(audit, options)).toThrow('REQUEST_CREDENTIAL_FIELD');
    expect(() => freezeAudit(audit, { ...options, reconstructed: { ...frozen.request!, endpoint: 'https://host/api?key=secret' } })).toThrow('ENDPOINT_UNSAFE');
  });
});

describe('controlled comparison', () => {
  it('changes only one system block and gives every trial independent input', async () => {
    const frozen = exampleCase();
    const selected = target(frozen);
    const plan = planRun(frozen, [selected], 3, exampleCandidate, 7);
    expect(plan.jobs.map((j) => j.id)).toEqual(planRun(frozen, [selected], 3, exampleCandidate, 7).jobs.map((j) => j.id));
    expect(plan.jobs).toHaveLength(6);
    for (const job of plan.jobs) {
      const restored = structuredClone(job.request);
      if (job.variant === 'candidate') systemText(restored, selected.protocol, systemText(structuredClone(selected.request), selected.protocol));
      expect(restored).toEqual(selected.request);
    }
    const execute = vi.fn(async (request) => { request.body.model = 'mutated'; return output(); });
    const snapshots: unknown[] = [];
    const run = await executePlan(plan, (r) => snapshots.push(structuredClone(r)), execute);
    expect(execute).toHaveBeenCalledTimes(6);
    expect(run.complete).toBe(true);
    expect(JSON.stringify(run)).not.toContain(selected.apiKey);
    expect(run.targets[0].request.body.model).toBe('synthetic-recorder');
    expect((snapshots[0] as { trials: unknown[] }).trials).toHaveLength(0);
    expect(run.trials.every((t) => t.requestHash === run.targets[0][t.variant === 'original' ? 'originalHash' : 'candidateHash'])).toBe(true);
  });
  it('replaces only the primary system block in each supported protocol', () => {
    for (const [protocol, body] of [
      ['chat_completions', { messages: [{ role: 'system', content: 'old' }, { role: 'system', content: 'format' }] }],
      ['responses', { input: [{ role: 'system', content: 'old' }, { role: 'user', content: 'task' }] }],
      ['anthropic_messages', { system: [{ type: 'text', text: 'old' }, { type: 'text', text: 'format' }] }],
    ] as const) {
      const request = { ...exampleCase().request!, body: structuredClone(body) as Record<string, unknown> };
      expect(systemText(request, protocol, 'new')).toBe('old');
      expect(systemText(request, protocol)).toBe('new');
      expect(JSON.stringify(request.body)).toContain(protocol === 'responses' ? 'task' : 'format');
    }
  });
  it('strips native continuation and keeps schema when crossing protocols', () => {
    const frozen = exampleCase();
    frozen.messages.splice(2, 0, { role: 'assistant', content: 'portable text', native: { protocol: 'responses', binding: 'other-binding', items: [{ type: 'reasoning', encrypted_content: 'must-not-migrate' }] } });
    const config = { model: 'other', baseUrl: 'https://example.test/v1', apiKey: 'memory-only', apiProtocol: 'anthropic_messages' as const, temperature: 0.7, timeoutSec: 90, toolMode: 'tools' as const };
    const wire = portableRequest(frozen, config);
    expect(JSON.stringify(wire)).not.toContain('must-not-migrate');
    expect(JSON.stringify(wire)).not.toContain(config.apiKey);
    expect(JSON.stringify(wire)).toContain('portable text');
    expect((wire.body.tools as any[])[0].input_schema).toEqual((frozen.request!.body.tools as any[])[0].function.parameters);
    assertCredentialRoute(wire, config);
    expect(() => assertCredentialRoute({ ...wire, endpoint: 'https://attacker.test/v1/messages' }, config)).toThrow('BINDING_MISMATCH');
  });
  it('migrates old call IDs only for portable encoding while preserving the frozen record', () => {
    const frozen = exampleCase();
    const legacy = { role: 'assistant', content: null, tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'record_facts', arguments: '{}' } }] };
    (frozen.messages as unknown[]).push(legacy, { role: 'tool', tool_call_id: 'old-call', content: 'rejected' });
    const before = structuredClone(frozen.messages);
    const wire = portableRequest(frozen, { model: 'other', baseUrl: 'https://example.test/v1', apiKey: null, apiProtocol: 'responses', temperature: 0.7, timeoutSec: 90, toolMode: 'tools' });
    const items = wire.body.input as any[];
    const call = items.find((i) => i.type === 'function_call');
    expect(call.name).toBe('record_facts');
    expect(items.find((i) => i.type === 'function_call_output').call_id).toBe(call.call_id);
    expect(frozen.messages).toEqual(before);
  });
});

describe('honest report denominators and CLI path', () => {
  it('freezes a synthetic audit then replays exactly once through the CLI', async () => {
    const directory = temporary();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const master = Buffer.alloc(32, 7);
    writeFileSync(join(directory, 'secret.key'), master.toString('base64'));
    const library = new ModelLibrary(new SecretBox(master), join(directory, 'models.json'));
    const model = library.add('fixture-recorder', 'https://fixture.invalid/v1', 'fixture-credential');
    const frozen = exampleCase();
    const request = structuredClone(frozen.request!);
    request.endpoint = 'https://fixture.invalid/v1/chat/completions';
    request.body.model = 'fixture-recorder';
    request.binding = protocolBinding({ apiProtocol: 'chat_completions', baseUrl: 'https://fixture.invalid/v1', model: 'fixture-recorder', apiKey: 'fixture-credential' });
    const audit: AuditEntry = { id: 3, at: 0, seat: 4, model: 'fixture-recorder', apiProtocol: 'chat_completions', decisionId: 'd', projectionVersion: 1, ok: false, messages: frozen.messages,
      request: { apiProtocol: 'chat_completions', tools: request.body.tools as unknown[], replay: request } };
    const auditFile = join(directory, 'synthetic.audit.jsonl');
    const originalAudit = `${JSON.stringify(audit)}\n`;
    writeFileSync(auditFile, originalAudit);
    writeFileSync(join(directory, 'rubric.json'), JSON.stringify(frozen.rubric));
    const caseDir = join(directory, 'frozen');
    await main(['freeze', `--audit-file=${auditFile}`, '--audit=3', '--room=fixture-room', '--case-id=fixture', `--rubric=${join(directory, 'rubric.json')}`, `--output=${caseDir}`]);
    expect(readFileSync(auditFile, 'utf8')).toBe(originalAudit);
    const saved = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8'));
    expect(saved.fidelity).toBe('captured');
    expect(saved.request).toEqual(request);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ model: 'fixture-recorder', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'record_facts', arguments: '{"seat":1,"result":"werewolf","night":1}' } }] } }] }));
    const runDir = join(directory, 'replay');
    await main(['replay', `--case=${join(caseDir, 'case.json')}`, `--models=${model.id}`, `--data-dir=${directory}`, `--output=${runDir}`, '--live']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(request.endpoint);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(request.body);
    expect(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).trials).toHaveLength(1);
    expect(readFileSync(join(runDir, 'report-unreviewed.md'), 'utf8')).toContain('不可估计');
  });
  it('does not turn failures or uncertainty into successful responses', async () => {
    const frozen = exampleCase();
    const plan = planRun(frozen, [target(frozen)], 2, exampleCandidate);
    let i = 0;
    const run = await executePlan(plan, () => {}, async () => output(i++ === 0 ? 'failed' : 'completed'));
    const labels = labelTemplate(run);
    const text = report(frozen, run, labels);
    expect(text).toContain('不可估计');
    expect(text).toContain('不计入可判定响应');
    expect(JSON.stringify(blindReview(run))).not.toContain('candidate');
    expect(JSON.stringify(blindReview(run))).not.toContain('model-a');
    labels.labels[0].verdict = 'pass';
    expect(() => report(frozen, run, labels)).toThrow('LABELS_FAILED_RESPONSE');
    const wrong: Labels = { runHash: 'wrong', labels: [] };
    expect(() => report(frozen, run, wrong)).toThrow('LABELS_INVALID');
    run.targets[0].request.body.temperature = 0;
    expect(() => report(frozen, run)).toThrow('RUN_INVALID');
  });
  it('runs the documented offline demo and report command without network', async () => {
    const directory = temporary();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('network forbidden'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = join(directory, 'demo');
    await main(['demo', `--output=${out}`]);
    const frozen = JSON.parse(readFileSync(join(out, 'case.json'), 'utf8')) as FrozenCase;
    const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
    expect(run.trials).toHaveLength(4);
    expect(fetchMock).not.toHaveBeenCalled();
    const labels = JSON.parse(readFileSync(join(out, 'labels.json'), 'utf8'));
    expect(labels.runHash).toBe(digest(run));
    const analysis = join(directory, 'analysis.md');
    writeFileSync(analysis, '只验证合成夹具流程。');
    const reportPath = join(directory, 'reviewed.md');
    await main(['report', `--case=${join(out, 'case.json')}`, `--run=${join(out, 'run.json')}`, `--labels=${join(out, 'labels.json')}`, `--analysis=${analysis}`, `--output=${reportPath}`]);
    expect(readFileSync(reportPath, 'utf8')).toContain('只验证合成夹具流程');
    await expect(main(['demo', `--output=${out}`])).rejects.toThrow();
    expect(frozen.synthetic).toBe(true);
  });
});
