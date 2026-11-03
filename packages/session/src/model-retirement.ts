export type EvidenceStatus = 'available' | 'retired_confirmed' | 'credential_invalid' | 'access_denied' | 'network_error' | 'temporary_unavailable' | 'unknown';

/** specific.id 须由维护者生成随机 UUID v4；账号维度绑定一个账号／套餐组合。格式校验不证明标识来源。 */
export type ScopeDimension = { kind: 'specific'; id: string } | { kind: 'global' } | { kind: 'unknown' };
export interface EvidenceScopeBinding { version: 1; accountScope: ScopeDimension; region: ScopeDimension }
export interface EvidenceScope extends EvidenceScopeBinding { routeId: string }
/** 旧记录只读保留，缺省或旧字符串均不能被解释为 global。 */
interface LegacyEvidenceScope { routeId: string; version?: undefined; accountScope?: string; region?: string }

export function isScopeBinding(value: unknown): value is EvidenceScopeBinding {
  if (!value || typeof value !== 'object') return false;
  const scope = value as Record<string, unknown>;
  return scope.version === 1 &&
    Object.keys(scope).every((key) => ['version', 'accountScope', 'region', 'routeId'].includes(key)) &&
    isDimension(scope.accountScope) && isDimension(scope.region);
}

function isDimension(value: unknown): value is ScopeDimension {
  if (!value || typeof value !== 'object') return false;
  const dimension = value as Record<string, unknown>;
  if (dimension.kind === 'global' || dimension.kind === 'unknown') return Object.keys(dimension).length === 1;
  return dimension.kind === 'specific' && Object.keys(dimension).length === 2 && typeof dimension.id === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(dimension.id);
}

function covers(evidence: ScopeDimension, target: ScopeDimension): boolean {
  // 显式 global 来源覆盖所有目标；unknown 来源永远不能确证范围，包括 unknown === unknown。
  return evidence.kind === 'global' || (evidence.kind === 'specific' && target.kind === 'specific' && evidence.id === target.id);
}

export function scopeCovers(evidence: RetirementEvidence['scope'], target: RetirementEvidence['scope']): boolean {
  return isScopeBinding(evidence) && isScopeBinding(target) && evidence.routeId === target.routeId &&
    covers(evidence.accountScope, target.accountScope) && covers(evidence.region, target.region);
}

/** 分类只接受已归因的结构化证据，不根据 HTTP 状态或错误文本推断停供。 */
export interface RetirementEvidence {
  kind: 'official_retirement' | 'documented_retirement' | 'verified_available' | 'authentication' | 'authorization' | 'transport' | 'temporary' | 'unattributed';
  providerId: string; model: string; protocol?: string;
  checkedAt: string; effectiveAt?: string; sourceUrl?: string; sourceDigest: string; reasonCode: string;
  summary?: string;
  scope: EvidenceScope | LegacyEvidenceScope;
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
      !scopeCovers(evidence.scope, target.scope) ||
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
