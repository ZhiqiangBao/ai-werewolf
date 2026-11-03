import { createHash } from 'node:crypto';
import { apiUrl } from '@werewolf/protocol';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ModelLibrary, sameModelRoute, type ModelLifecycle, type ResolvedModel } from './model-library';
import type { SecretBox } from './secret';
import { classifyEvidenceSet, type EvidenceStatus, type RetirementEvidence } from './model-retirement';
import { acquireDataLease } from './data-lease';

export interface ReferenceSummary { roomId: string; status: 'setup' | 'running' | 'ended'; paused: boolean; seat: number }
export interface ModelImpact {
  modelId: string; revision: string; inventoryDigest: string;
  exactRefs: ReferenceSummary[]; possibleRefs: ReferenceSummary[];
  credentialDependencies: string[]; blockers: string[]; canArchive: boolean;
  scope: string; evidence: RetirementEvidence[]; evidenceStatus: EvidenceStatus; evidenceReason: string;
  evidenceTarget: Pick<RetirementEvidence, 'providerId' | 'model' | 'protocol' | 'scope'>;
  mergedInto?: string;
}
export interface ModelAliasEvidence {
  kind: 'official_same_model'; sourceModel: string; targetModel: string; providerId: string; routeId: string; protocol: string;
  checkedAt: string; sourceUrl: string; sourceDigest: string; summary: string;
}
export interface MergeImpact {
  sourceId: string; targetId: string; revision: string; inventoryDigest: string;
  source: ModelImpact; target: ModelImpact; equivalence: 'identical_model' | 'official_alias'; alreadyMerged: boolean;
}

/** 不包含密钥、查询参数或完整地址；账号和区域未知时只能记录覆盖全局范围的证据。 */
function evidenceTarget(model: ResolvedModel): ModelImpact['evidenceTarget'] {
  const url = new URL(model.baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('MODEL_INVENTORY_INVALID');
  return { providerId: url.hostname.toLowerCase(), model: model.model, protocol: model.apiProtocol, scope: { routeId: createHash('sha256').update(url.origin.toLowerCase() + url.pathname).digest('hex') } };
}

/** 调用方必须在完整生命周期内持有数据目录租约。 */
export class ModelMaintenance {
  constructor(private readonly directory: string, private readonly secrets: SecretBox) {}

  preview(modelId: string): ModelImpact {
    const library = new ModelLibrary(this.secrets, join(this.directory, 'models.json'));
    const model = library.findRaw(modelId);
    if (!model) throw new Error('MODEL_NOT_FOUND');
    const exactRefs: ReferenceSummary[] = [], possibleRefs: ReferenceSummary[] = [];
    const dir = join(this.directory, 'rooms');
    const inventory: string[] = [];
    if (existsSync(dir)) for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const raw = readFileSync(join(dir, name), 'utf8');
      const room = JSON.parse(raw) as { id?: unknown; status?: unknown; paused?: unknown; seats?: unknown };
      if (typeof room.id !== 'string' || !['setup', 'running', 'ended'].includes(String(room.status)) || !Array.isArray(room.seats) || typeof room.paused !== 'boolean') throw new Error('MODEL_INVENTORY_INVALID');
      inventory.push(`${name}:${createHash('sha256').update(raw).digest('hex')}`);
      for (const seat of room.seats) {
        if (!seat || typeof seat !== 'object' || !Number.isInteger(seat.seat) || seat.seat < 1 ||
            (seat.modelId !== undefined && seat.modelId !== null && (typeof seat.modelId !== 'string' || !seat.modelId)) ||
            (seat.controller !== 'human' && seat.controller !== 'ai') ||
            (seat.adapter !== 'mock' && seat.adapter !== 'openai_compatible') ||
            (seat.model !== undefined && typeof seat.model !== 'string') ||
            (seat.baseUrl !== undefined && typeof seat.baseUrl !== 'string') ||
            (seat.apiProtocol !== undefined && !['chat_completions', 'responses', 'anthropic_messages'].includes(seat.apiProtocol)) ||
            (seat.adapter === 'openai_compatible' && (typeof seat.model !== 'string' || typeof seat.baseUrl !== 'string'))) throw new Error('MODEL_INVENTORY_INVALID');
        const ref: ReferenceSummary = { roomId: room.id, status: room.status as ReferenceSummary['status'], paused: room.paused, seat: seat.seat };
        if (seat.modelId === modelId || (seat.modelId && library.find(seat.modelId)?.id === modelId)) exactRefs.push(ref);
        else if (library.list().some((candidate) => (candidate.id === modelId || candidate.mergedInto === modelId) && seat.model === candidate.model && (seat.apiProtocol ?? 'chat_completions') === candidate.apiProtocol && typeof seat.baseUrl === 'string' && sameModelRoute(seat.baseUrl, candidate.baseUrl, candidate.apiProtocol))) possibleRefs.push(ref);
      }
    }
    const credentialDependencies: string[] = [];
    try {
      const models = library.list();
      const selected = models.find((m) => new URL(m.baseUrl).hostname === 'token-plan.maas.qianwenaiapi.com' && m.apiKey?.startsWith('sk-sp-'));
      if (selected?.id === model.id) credentialDependencies.push('Qwen Token Plan TTS 当前项目凭据回退使用此条目；归档保留密钥且回退仍可读取');
      else if (new URL(model.baseUrl).hostname === 'token-plan.maas.qianwenaiapi.com' && model.apiKey?.startsWith('sk-sp-')) credentialDependencies.push('Qwen Token Plan TTS 可用的后备凭据；归档保留密钥且回退仍可读取');
    } catch { throw new Error('MODEL_INVENTORY_INVALID'); }
    const blockers: string[] = [];
    if (model.mergedInto) blockers.push('已归并的条目由规范模型管理');
    if ([...exactRefs, ...possibleRefs].some((r) => r.status !== 'ended')) blockers.push('存在待开局或运行中的房间引用');
    const inventoryDigest = createHash('sha256').update(JSON.stringify({ inventory, exactRefs, possibleRefs, credentialDependencies })).digest('hex');
    const target = evidenceTarget(model);
    const status = classifyEvidenceSet(model.evidence, target);
    const reason = !model.evidence.length ? '没有核验证据' : status === 'unknown' ? '证据不足、过期、范围不符或来源互相矛盾' : '全部记录的有效证据在此模型和路由范围内一致';
    return { modelId, revision: library.revision(), inventoryDigest, exactRefs, possibleRefs, credentialDependencies, blockers, canArchive: blockers.length === 0, scope: '项目房间元数据及内置 Qwen TTS 回退；外部消费者未知', evidence: model.evidence, evidenceStatus: status, evidenceReason: reason, evidenceTarget: target, ...(model.mergedInto ? { mergedInto: model.mergedInto } : {}) };
  }

  recordEvidence(modelId: string, evidence: RetirementEvidence, expectedRevision: string): void {
    const library = new ModelLibrary(this.secrets, join(this.directory, 'models.json'));
    const model = library.findRaw(modelId);
    if (!model) throw new Error('MODEL_NOT_FOUND');
    if (library.revision() !== expectedRevision) throw new Error('MODEL_PREVIEW_STALE');
    const target = evidenceTarget(model);
    if (!evidence || evidence.model !== target.model || evidence.protocol !== target.protocol || evidence.providerId !== target.providerId || evidence.scope?.routeId !== target.scope.routeId || evidence.scope.accountScope !== undefined || evidence.scope.region !== undefined || !/^[a-f0-9]{64}$/i.test(evidence.sourceDigest) || !Number.isFinite(Date.parse(evidence.checkedAt)) || !evidence.reasonCode || !evidence.summary || evidence.summary.length > 500 || /(?:sk-[\w-]{8,}|bearer\s+\S+|https?:\/\/\S+)/i.test(evidence.summary) || !['official_retirement', 'documented_retirement', 'verified_available', 'authentication', 'authorization', 'transport', 'temporary', 'unattributed'].includes(evidence.kind)) throw new Error('MODEL_EVIDENCE_INVALID');
    if (evidence.sourceUrl) {
      let url: URL;
      try { url = new URL(evidence.sourceUrl); } catch { throw new Error('MODEL_EVIDENCE_INVALID'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('MODEL_EVIDENCE_INVALID');
    }
    library.addEvidence(modelId, evidence);
  }

  previewMerge(sourceId: string, targetId: string, evidence?: ModelAliasEvidence): MergeImpact {
    if (sourceId === targetId) throw new Error('MODEL_MERGE_CONFLICT');
    const library = new ModelLibrary(this.secrets, join(this.directory, 'models.json'));
    const source = library.findRaw(sourceId), target = library.findRaw(targetId);
    if (!source || !target) throw new Error('MODEL_NOT_FOUND');
    if (target.mergedInto || (source.mergedInto && source.mergedInto !== targetId) || library.list().some((m) => m.mergedInto === sourceId)) throw new Error('MODEL_MERGE_CONFLICT');
    const alreadyMerged = source.mergedInto === targetId;
    if (!alreadyMerged && (source.lifecycle !== 'active' || target.lifecycle !== 'active')) throw new Error('MODEL_MERGE_CONFLICT');
    if (!source.apiKey || !target.apiKey || source.apiKey !== target.apiKey || source.apiProtocol !== target.apiProtocol) throw new Error('MODEL_MERGE_MISMATCH');
    let sourceUrl: string, targetUrl: string;
    try { sourceUrl = new URL(apiUrl(source.baseUrl, source.apiProtocol)).href; targetUrl = new URL(apiUrl(target.baseUrl, target.apiProtocol)).href; }
    catch { throw new Error('MODEL_MERGE_MISMATCH'); }
    if (sourceUrl !== targetUrl) throw new Error('MODEL_MERGE_MISMATCH');
    const equivalence = source.model === target.model ? 'identical_model' : 'official_alias';
    if (equivalence === 'official_alias') {
      const scope = evidenceTarget(source);
      if (!evidence || evidence.kind !== 'official_same_model' || evidence.sourceModel !== source.model || evidence.targetModel !== target.model || evidence.protocol !== source.apiProtocol || evidence.providerId !== scope.providerId || evidence.routeId !== scope.scope.routeId || !/^[a-f0-9]{64}$/i.test(evidence.sourceDigest) || !Number.isFinite(Date.parse(evidence.checkedAt)) || Date.parse(evidence.checkedAt) > Date.now() || typeof evidence.summary !== 'string' || !evidence.summary || evidence.summary.length > 500 || /(?:sk-[\w-]{8,}|bearer\s+\S+|https?:\/\/\S+)/i.test(evidence.summary)) throw new Error('MODEL_ALIAS_EVIDENCE_INVALID');
      try { const url = new URL(evidence.sourceUrl); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error(); }
      catch { throw new Error('MODEL_ALIAS_EVIDENCE_INVALID'); }
    }
    const sourceImpact = this.preview(sourceId), targetImpact = this.preview(targetId);
    const revision = library.revision();
    const inventoryDigest = createHash('sha256').update(JSON.stringify({ sourceId, targetId, source: sourceImpact.inventoryDigest, target: targetImpact.inventoryDigest, evidence: evidence ?? null })).digest('hex');
    return { sourceId, targetId, revision, inventoryDigest, source: sourceImpact, target: targetImpact, equivalence, alreadyMerged };
  }

  merge(sourceId: string, targetId: string, expectedRevision: string, expectedInventoryDigest: string, evidence?: ModelAliasEvidence): MergeImpact {
    const impact = this.previewMerge(sourceId, targetId, evidence);
    if (impact.revision !== expectedRevision || impact.inventoryDigest !== expectedInventoryDigest) throw new Error('MODEL_PREVIEW_STALE');
    if (!impact.alreadyMerged) new ModelLibrary(this.secrets, join(this.directory, 'models.json')).merge(sourceId, targetId, evidence ?? { kind: 'identical_model' });
    return this.previewMerge(sourceId, targetId, evidence);
  }

  apply(command: { modelId: string; operation: 'disable' | 'archive' | 'restore' | 'enable'; expectedRevision: string; expectedInventoryDigest: string }): { lifecycle: ModelLifecycle; warnings: string[] } {
    const impact = this.preview(command.modelId);
    if (impact.revision !== command.expectedRevision || impact.inventoryDigest !== command.expectedInventoryDigest) throw new Error('MODEL_PREVIEW_STALE');
    const library = new ModelLibrary(this.secrets, join(this.directory, 'models.json'));
    const current = library.findRaw(command.modelId)!;
    if (current.mergedInto) throw new Error('MODEL_MERGED');
    let lifecycle: ModelLifecycle;
    switch (command.operation) {
      case 'disable':
        if (current.lifecycle === 'archived') throw new Error('MODEL_RESTORE_REQUIRED');
        lifecycle = 'disabled'; break;
      case 'archive':
        if (!impact.canArchive) throw new Error('MODEL_IN_USE');
        lifecycle = 'archived'; break;
      case 'restore':
        if (current.lifecycle !== 'archived') throw new Error('MODEL_RESTORE_CONFLICT');
        if (library.list().some((m) => m.id !== current.id && !m.mergedInto && m.lifecycle !== 'archived' && m.model === current.model && m.apiProtocol === current.apiProtocol && sameModelRoute(m.baseUrl, current.baseUrl, m.apiProtocol))) throw new Error('MODEL_RESTORE_CONFLICT');
        lifecycle = 'disabled'; break;
      case 'enable':
        if (current.lifecycle === 'archived') throw new Error('MODEL_RESTORE_REQUIRED');
        lifecycle = 'active'; break;
      default: throw new Error('MODEL_OPERATION_INVALID');
    }
    if (current.lifecycle !== lifecycle) library.setLifecycle(command.modelId, lifecycle);
    const warnings = command.operation === 'enable' && impact.evidenceStatus === 'retired_confirmed' ? ['存在仍有效的停供证据，请核对范围。'] : [];
    return { lifecycle, warnings };
  }
}

/** 本机调用的统一入口：盘点和写入期间始终持有同一个租约。 */
export function withModelMaintenance<T>(directory: string, secrets: SecretBox, action: (maintenance: ModelMaintenance) => T): T {
  const release = acquireDataLease(directory);
  try { return action(new ModelMaintenance(directory, secrets)); } finally { release(); }
}
