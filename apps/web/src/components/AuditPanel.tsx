import { useCallback, useEffect, useState } from 'react';
import type { AuditEntry } from '@werewolf/protocol';
import { api } from '../api';
import { formatTime, seatName } from '../util';

interface Message {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

const ROLE_LABEL: Record<string, string> = { system: '系统提示', user: '用户消息', assistant: '模型回复', tool: '工具结果' };
const PAGE = 60;

/** 房主可见的模型调用记录：完整提示词、模型原始回复、解析出的工具调用。 */
export function AuditPanel({ roomId, token }: { roomId: string; token: string }) {
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
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <select value={seat} onChange={(e) => setSeat(Number(e.target.value))} style={{ width: 120 }}>
          <option value={0}>全部座位</option>
          {seats.map((s) => (
            <option key={s} value={s}>
              {seatName(s)}
            </option>
          ))}
        </select>
        <span className="muted small">共 {list.length} 条，新的在上</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => void load()}>
          刷新
        </button>
      </div>
      {error && <div className="error-box small">{error}</div>}
      {entries && !list.length && <div className="muted small">还没有模型调用记录。模拟玩家（mock）也会记录。</div>}
      {list.slice(0, limit).map((e) => (
        <details key={e.id} className="audit-item">
          <summary>
            <span className="dim tiny">{formatTime(e.at)}</span>
            <b>{seatName(e.seat)}</b>
            <span className="tag">{e.model}</span>
            {e.purpose && <span className="tag">{e.purpose === 'listen' ? '旁听' : '行动'}</span>}
            <span className={`tag ${e.ok ? 'ok' : 'bad'}`}>{e.ok ? '被采纳' : '未采纳'}</span>
            {e.toolCall && <code className="small">{e.toolCall.tool}({JSON.stringify(e.toolCall.args).slice(0, 80)})</code>}
            {e.latencyMs !== undefined && <span className="dim tiny">{e.latencyMs} ms</span>}
            {e.firstDeltaMs !== undefined && <span className="dim tiny">首段 {e.firstDeltaMs} ms</span>}
          </summary>
          {e.error && <div className="error-box small" style={{ margin: '6px 10px' }}>{e.error}</div>}
          <div className="tiny dim" style={{ margin: '0 10px' }}>
            决策 {e.decisionId} · 视图版本 {e.projectionVersion}
            {e.thinkingMode && <> · 思考档位 {e.thinkingMode}</>}
            {e.thinkingChars !== undefined && <> · 思考 {e.thinkingChars} 字符 / 工具外正文 {e.replyChars ?? 0} 字符</>}
          </div>
          {Array.isArray(e.messages) &&
            (e.messages as Message[]).map((m, i) => (
              <div key={i} className="msg">
                <div className="role">{ROLE_LABEL[m.role] ?? m.role}</div>
                {m.content && <pre>{m.content}</pre>}
                {m.tool_calls !== undefined && <pre className="dim">{JSON.stringify(m.tool_calls, null, 2)}</pre>}
              </div>
            ))}
          {e.response !== undefined && (
            <div className="msg">
              <div className="role">模型原始回复</div>
              <pre>{typeof e.response === 'string' ? e.response : JSON.stringify(e.response, null, 2)}</pre>
            </div>
          )}
        </details>
      ))}
      {list.length > limit && (
        <button className="btn sm ghost" onClick={() => setLimit((n) => n + PAGE)}>
          再显示 {Math.min(PAGE, list.length - limit)} 条
        </button>
      )}
    </div>
  );
}
