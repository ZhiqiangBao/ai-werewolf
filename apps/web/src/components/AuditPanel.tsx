import { useCallback, useEffect, useState } from 'react';
import { API_PROTOCOL_LABELS, gameText, type AuditEntry } from '@werewolf/protocol';
import { useI18n } from '../i18n';
import { api } from '../api';
import { formatTime } from '../util';

interface Message {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  calls?: unknown;
}

const ROLE_LABEL: Record<string, string> = { system: '系统提示', user: '用户消息', assistant: '模型回复', tool: '工具结果' };
const PAGE = 60;

/** 房主可见的模型调用记录：完整提示词、模型原始回复、解析出的工具调用。 */
export function AuditPanel({ roomId, token, locale }: { roomId: string; token: string; locale?: string }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seat, setSeat] = useState<number | 0>(0);
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async () => {
    try {
      setEntries(await api.audit(roomId, token));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [roomId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const seats = [...new Set((entries ?? []).map((e) => e.seat))].sort((a, b) => a - b);
  const list = (entries ?? []).filter((e) => !seat || e.seat === seat).reverse();

  return (
    <div className="audit-panel" role="region" aria-label={t('模型调用记录')} tabIndex={0}>
      <div className="row" style={{ marginBottom: 10 }}>
        <select value={seat} onChange={(e) => setSeat(Number(e.target.value))} style={{ width: 120 }}>
          <option value={0}>{t('全部座位')}</option>
          {seats.map((s) => (
            <option key={s} value={s}>
              {gameText(locale, '{0}号', s)}
            </option>
          ))}
        </select>
        <span className="muted small">{t('共 {0} 条，新的在上', list.length)}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => void load()}>
          {t('刷新')}
        </button>
      </div>
      {error && <div className="error-box small">{error}</div>}
      {entries && !list.length && <div className="muted small">{t('还没有模型调用记录。模拟玩家（mock）也会记录。')}</div>}
      {list.slice(0, limit).map((e) => (
        <details key={e.id} className="audit-item">
          <summary>
            <span className="dim tiny">{formatTime(e.at)}</span>
            <b>{gameText(locale, '{0}号', e.seat)}</b>
            <span className="tag">{e.model}</span>
            {e.purpose && <span className="tag">{t(e.purpose === 'listen' ? '旁听' : '行动')}</span>}
            <span className={`tag ${e.ok ? 'ok' : 'bad'}`}>{t(e.ok ? '被采纳' : '未采纳')}</span>
            {e.toolCall && <code className="small">{e.toolCall.tool}({JSON.stringify(e.toolCall.args).slice(0, 80)})</code>}
            {e.latencyMs !== undefined && <span className="dim tiny">{e.latencyMs} ms</span>}
            {e.firstDeltaMs !== undefined && <span className="dim tiny">{t('首段 {0} ms', e.firstDeltaMs)}</span>}
          </summary>
          {e.error && <div className="error-box small" style={{ margin: '6px 10px' }}>{e.error}</div>}
          <div className="tiny dim" style={{ margin: '0 10px' }}>
            {t('决策 {0} · 视图版本 {1}', e.decisionId, e.projectionVersion)}
            {e.thinkingMode && <> · {t('思考档位 {0}', e.thinkingMode)}</>}
            {e.apiProtocol && <> · {API_PROTOCOL_LABELS[e.apiProtocol]}</>}
            {e.thinkingChars !== undefined && <> · {t('思考 {0} 字符 / 工具外正文 {1} 字符', e.thinkingChars, e.replyChars ?? 0)}</>}
            {e.usage && <> · {t('输入 {0} / 输出 {1} token · 缓存读取 {2} / 写入 {3}', e.usage.inputTokens, e.usage.outputTokens, e.usage.cacheReadTokens, e.usage.cacheWriteTokens)}</>}
          </div>
          {e.request && (
            <details className="msg">
              <summary className="role">{t('实际发送的工具与参数格式')}</summary>
              <pre>{JSON.stringify(e.request, null, 2)}</pre>
            </details>
          )}
          {Array.isArray(e.messages) &&
            (e.messages as Message[]).map((m, i) => (
              <div key={i} className="msg">
                <div className="role">{ROLE_LABEL[m.role] ? t(ROLE_LABEL[m.role]) : m.role}</div>
                {m.content && <pre>{m.content}</pre>}
                {m.tool_calls !== undefined && <pre className="dim">{JSON.stringify(m.tool_calls, null, 2)}</pre>}
                {m.calls !== undefined && <pre className="dim">{JSON.stringify(m.calls, null, 2)}</pre>}
              </div>
            ))}
          {e.response !== undefined && (
            <div className="msg">
              <div className="role">{t('模型原始回复')}</div>
              <pre>{typeof e.response === 'string' ? e.response : JSON.stringify(e.response, null, 2)}</pre>
            </div>
          )}
        </details>
      ))}
      {list.length > limit && (
        <button className="btn sm ghost" onClick={() => setLimit((n) => n + PAGE)}>
          {t('再显示 {0} 条', Math.min(PAGE, list.length - limit))}
        </button>
      )}
    </div>
  );
}
