export type EvidenceStatus = 'available' | 'retired_confirmed' | 'credential_invalid' | 'access_denied' | 'network_error' | 'temporary_unavailable' | 'unknown';

/** 分类只接受已归因的结构化证据，不根据 HTTP 状态或错误文本推断停供。 */
export interface RetirementEvidence {
  kind: 'official_retirement' | 'documented_retirement' | 'verified_available' | 'authentication' | 'authorization' | 'transport' | 'temporary' | 'unattributed';
  providerId: string; model: string; protocol?: string;
  checkedAt: string; effectiveAt?: string; sourceUrl?: string; sourceDigest: string; reasonCode: string;
  summary?: string;
  scope: { routeId: string; accountScope?: string; region?: string };
  expiresAt?: string;
}

/** 多条来源不一致或任一来源失效时保留待复核，不自动选择有利结论。 */
export function classifyEvidenceSet(evidence: RetirementEvidence[], target: Pick<RetirementEvidence, 'providerId' | 'model' | 'protocol' | 'scope'>, now = Date.now()): EvidenceStatus {
  if (!evidence.length) return 'unknown';
  const results = evidence.map((entry) => classifyEvidence(entry, target, now));
  return results.every((status) => status === results[0]) ? results[0] : 'unknown';
}

export function classifyEvidence(evidence: RetirementEvidence, target: Pick<RetirementEvidence, 'providerId' | 'model' | 'protocol' | 'scope'>, now = Date.now()): EvidenceStatus {
  if (!evidence || typeof evidence !== 'object') return 'unknown';
  const time = Date.parse(evidence.checkedAt);
  if (!Number.isFinite(time) || time > now || !/^[a-f0-9]{64}$/i.test(evidence.sourceDigest) || !evidence.reasonCode || typeof evidence.summary !== 'string' || !evidence.summary || evidence.summary.length > 500 || /(?:sk-[\w-]{8,}|bearer\s+\S+|https?:\/\/\S+)/i.test(evidence.summary) || !evidence.scope?.routeId ||
      evidence.providerId !== target.providerId || evidence.model !== target.model || evidence.protocol !== target.protocol ||
      evidence.scope.routeId !== target.scope.routeId || evidence.scope.accountScope !== target.scope.accountScope || evidence.scope.region !== target.scope.region ||
      (evidence.expiresAt !== undefined && (!Number.isFinite(Date.parse(evidence.expiresAt)) || Date.parse(evidence.expiresAt) <= now))) return 'unknown';
  switch (evidence.kind) {
    case 'official_retirement': case 'documented_retirement':
      try {
        if (!evidence.sourceUrl) return 'unknown';
        const url = new URL(evidence.sourceUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return 'unknown';
      } catch { return 'unknown'; }
      if (!evidence.effectiveAt || !Number.isFinite(Date.parse(evidence.effectiveAt)) || Date.parse(evidence.effectiveAt) > now) return 'unknown';
      return 'retired_confirmed';
    case 'verified_available': return evidence.expiresAt ? 'available' : 'unknown';
    case 'authentication': return 'credential_invalid';
    case 'authorization': return 'access_denied';
    case 'transport': return 'network_error';
    case 'temporary': return 'temporary_unavailable';
    default: return 'unknown';
  }
}
