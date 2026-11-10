import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@werewolf/protocol';
import { exampleCandidate, exampleCase, exampleTools } from '../src/diagnostics/hallucination-example';
import { blindReview, digest, executePlan, freezeAudit, improvementSummary, labelTemplate, planRun, report, systemText, verifyCase, type FrozenCase, type Labels, type Target, type TrialOutput } from '../src/diagnostics/hallucination';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temp = () => { const directory = resolve('data/diagnostics/hallucination/test-semantic'); mkdirSync(directory, { recursive: true }); directories.push(directory); return directory; };
const target = (frozen = exampleCase()): Target => ({ id: 'model-a', model: 'fixture', protocol: 'chat_completions', config: { apiProtocol: 'chat_completions', baseUrl: 'http://fixture.invalid/v1', model: 'fixture', apiKey: null, temperature: 0, toolMode: 'tools', timeoutSec: 1 } });
const result = (output: TrialOutput): Promise<TrialOutput> => Promise.resolve(output);

describe('semantic hallucination workflow', () => {
  it('freezes messages and tools while keeping the old response only as evidence', () => {
    const frozen = exampleCase();
    expect(frozen.version).toBe(2);
    expect(frozen.tools).toEqual(exampleTools);
    expect(JSON.stringify(frozen.messages)).not.toContain('历史错误示例');
    expect(JSON.stringify(frozen.original)).toContain('历史错误示例');
    verifyCase(JSON.parse(JSON.stringify(frozen)));
    frozen.messages[1].content = 'tampered';
    expect(() => verifyCase(frozen)).toThrow('CASE_HASH_MISMATCH');
  });

  it('marks a legacy audit incomplete without inventing tools', () => {
    const frozen = exampleCase();
    const audit: AuditEntry = { id: 8, at: 0, seat: 4, model: 'old', apiProtocol: 'chat_completions', decisionId: 'd', projectionVersion: 1, ok: true, messages: frozen.messages };
    const legacy = freezeAudit(audit, { roomId: 'r', caseId: 'c', rubric: frozen.rubric });
    expect(legacy.fidelity).toBe('incomplete');
    expect(legacy.tools).toEqual([]);
  });

  it('changes only the first system message and randomizes execution order reproducibly', () => {
    const frozen = exampleCase();
    const plan = planRun(frozen, [target()], 3, exampleCandidate, 7);
    expect(plan.jobs).toHaveLength(6);
    const candidate = plan.jobs.find((job) => job.variant === 'candidate')!;
    expect(systemText(candidate.messages)).toBe(exampleCandidate);
    expect(candidate.messages.slice(1)).toEqual(frozen.messages.slice(1));
    expect(plan.jobs.map((job) => job.id)).toEqual(planRun(frozen, [target()], 3, exampleCandidate, 7).jobs.map((job) => job.id));
  });

  it('runs a semantic plan through an injected executor and never serializes credentials', async () => {
    const frozen = exampleCase(); const plan = planRun(frozen, [target()], 2, exampleCandidate);
    const outputs: TrialOutput[] = [{ status: 'completed', text: '', call: { tool: 'record_facts', args: { seat: 1 } }, latencyMs: 1 }, { status: 'failed', failureKind: 'timeout', error: 'timeout', text: '', latencyMs: 1 }, { status: 'completed', text: '', call: { tool: 'record_facts', args: { seat: 1 } }, latencyMs: 1 }, { status: 'completed', text: '', call: { tool: 'record_facts', args: { seat: 4 } }, latencyMs: 1 }]; let i = 0;
    const run = await executePlan(plan, frozen, () => {}, async () => result(outputs[i++]));
    expect(run.complete).toBe(true); expect(run.trials).toHaveLength(4); expect(JSON.stringify(run)).not.toContain('credential');
    expect(blindReview(run).records.every((item) => !JSON.stringify(item).includes('model-a'))).toBe(true);
  });

  it('keeps failures out of the target-error denominator', () => {
    const frozen = exampleCase(); const plan = planRun(frozen, [target()], 1, exampleCandidate);
    const run = { ...plan.run, complete: true, trials: [{ id: 'model-a:original:1', targetId: 'model-a', variant: 'original' as const, repeat: 1, inputHash: 'x', output: { status: 'failed' as const, failureKind: 'timeout', text: '', latencyMs: 1 } }] };
    expect(report(frozen, run)).toContain('不可估计');
  });

  it('records target-error and candidate deltas in the structured improvement summary', () => {
    const frozen = exampleCase(); const plan = planRun(frozen, [target()], 1, exampleCandidate);
    const run = { ...plan.run, complete: true, trials: plan.jobs.map((job, index) => ({ id: job.id, targetId: job.target.id, variant: job.variant, repeat: job.repeat, inputHash: 'x', output: { status: 'completed' as const, text: '', call: { tool: 'record_facts', args: { seat: index } }, latencyMs: 1 } })) };
    const labels: Labels = { runHash: digest(run), labels: run.trials.map((trial) => ({ trialId: trial.id, verdict: trial.variant === 'original' ? 'target_error' as const : 'pass' as const, evidence: ['固定夹具证据'] })) };
    const summary = improvementSummary(frozen, run, labels) as { rows: { variant: string; targetErrorRate: number | null }[]; paired: { candidateMinusOriginalTargetErrorRate: number | null }[] };
    expect(summary.rows.find((row) => row.variant === 'original')?.targetErrorRate).toBe(1);
    expect(summary.rows.find((row) => row.variant === 'candidate')?.targetErrorRate).toBe(0);
    expect(summary.paired[0].candidateMinusOriginalTargetErrorRate).toBe(-1);
  });

  it('writes a synthetic case that can be reviewed without network access', () => {
    const directory = temp(); const frozen = exampleCase(); writeFileSync(join(directory, 'case.json'), JSON.stringify(frozen)); writeFileSync(join(directory, 'tools.json'), JSON.stringify(exampleTools));
    expect(JSON.parse(readFileSync(join(directory, 'case.json'), 'utf8')).caseHash).toBe(frozen.caseHash);
  });
});
