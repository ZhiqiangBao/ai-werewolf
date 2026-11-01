import { useEffect, useRef, useState } from 'react';
import type { ParamSpec, Projection, ToolCall, ToolSpec } from '@werewolf/protocol';
import { useNow } from '../hooks';
import { seatName, seatStyle } from '../util';

type Values = Record<string, unknown>;

function ready(p: ParamSpec, v: unknown): boolean {
  switch (p.kind) {
    case 'seat':
      return v !== undefined;
    case 'seats':
      return Array.isArray(v) && v.length >= p.min && v.length <= p.max;
    case 'boolean':
      return typeof v === 'boolean';
    case 'text': {
      const n = typeof v === 'string' ? v.trim().length : 0;
      return n >= p.minLength && (p.maxLength === undefined || n <= p.maxLength);
    }
    case 'choice':
      return typeof v === 'string';
  }
}

function argsOf(tool: ToolSpec, values: Values): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const p of tool.params) {
    const v = values[p.name];
    args[p.name] = p.kind === 'text' ? String(v ?? '').trim() : v;
  }
  return args;
}

function ParamInput({ p, value, onChange, onSubmit }: { p: ParamSpec; value: unknown; onChange: (v: unknown) => void; onSubmit: () => void }) {
  switch (p.kind) {
    case 'seat':
      return (
        <div className="seat-picker">
          {p.options.map((s) => (
            <button key={s} className={value === s ? 'on' : ''} style={seatStyle(s)} onClick={() => onChange(s)}>
              {seatName(s)}
            </button>
          ))}
          {p.nullable && (
            <button className={`null ${value === null ? 'on' : ''}`} onClick={() => onChange(null)}>
              {p.nullLabel ?? '不选'}
            </button>
          )}
        </div>
      );
    case 'seats': {
      const list = Array.isArray(value) ? (value as number[]) : [];
      return (
        <div className="seat-picker">
          {p.options.map((s) => (
            <button
              key={s}
              className={list.includes(s) ? 'on' : ''}
              style={seatStyle(s)}
              onClick={() => onChange(list.includes(s) ? list.filter((x) => x !== s) : [...list, s].sort((a, b) => a - b))}
            >
              {seatName(s)}
            </button>
          ))}
        </div>
      );
    }
    case 'boolean':
      return (
        <div className="seg">
          <button className={value === true ? 'on' : ''} onClick={() => onChange(true)}>
            {p.trueLabel ?? '是'}
          </button>
          <button className={value === false ? 'on' : ''} onClick={() => onChange(false)}>
            {p.falseLabel ?? '否'}
          </button>
        </div>
      );
    case 'text': {
      const text = typeof value === 'string' ? value : '';
      const n = text.trim().length;
      return (
        <>
          <textarea
            value={text}
            maxLength={p.maxLength}
            placeholder={p.placeholder ?? (p.minLength ? '' : '可以留空')}
            rows={p.maxLength !== undefined && p.maxLength > 300 ? 6 : 3}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSubmit();
            }}
          />
          {p.maxLength !== undefined && (
            <div className={`tiny ${n > p.maxLength || n < p.minLength ? 'muted' : 'dim'}`} style={{ textAlign: 'right' }}>
              {n} / {p.maxLength}　Ctrl+Enter 提交
            </div>
          )}
        </>
      );
    }
    case 'choice':
      return (
        <div className="choice-list">
          {p.options.map((o) => (
            <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
              {o.label}
              {o.hint && <div className="tiny muted">{o.hint}</div>}
            </button>
          ))}
        </div>
      );
  }
}

/** 通用表单：按工具的参数描述生成输入控件，新身份的工具不需要改网页。 */
export function ToolForm({ tool, busy, disabled, draftKey, onSubmit }: { tool: ToolSpec; busy: boolean; disabled?: boolean; draftKey?: string; onSubmit: (call: ToolCall) => void }) {
  const [values, setValues] = useState<Values>(() => {
    try {
      const saved: unknown = draftKey ? JSON.parse(sessionStorage.getItem(draftKey) ?? '{}') : {};
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Values : {};
    } catch { return {}; }
  });
  useEffect(() => {
    if (!draftKey) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify(values)); } catch { /* 存储不可用时仍可行动。 */ }
  }, [draftKey, values]);
  const ok = tool.params.every((p) => ready(p, values[p.name]));
  const submit = () => {
    if (!ok || busy || disabled) return;
    if (['wolf_explode', 'badge_tear'].includes(tool.name) && !confirm(`确定要「${tool.title}」吗？提交后无法撤回。`)) return;
    onSubmit({ tool: tool.name, args: argsOf(tool, values) });
  };
  return (
    <div>
      {tool.params.map((p) => (
        <div key={p.name} className="param">
          <div className="label">{p.label}</div>
          <ParamInput p={p} value={values[p.name]} onChange={(v) => setValues((x) => ({ ...x, [p.name]: v }))} onSubmit={submit} />
        </div>
      ))}
      <button className={`btn ${tool.params.length ? 'primary' : 'danger'}`} disabled={!ok || busy || disabled} onClick={submit}>
        {busy ? '提交中…' : tool.title}
      </button>
    </div>
  );
}

interface Props {
  projection: Projection;
  human: boolean;
  paused: boolean;
  onAct: (call: ToolCall, decisionId: string) => Promise<string | null>;
}

/** 座位的行动区：当前任务 + 随时可用的插入行动（例如自爆）。 */
export function TaskPanel({ projection: p, human, paused, onAct }: Props) {
  const task = p.task;
  const current = task?.decisionId ?? '';
  const [picked, setPicked] = useState({ id: '', idx: 0 });
  const [failure, setFailure] = useState({ id: '', msg: '' });
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [receipt, setReceipt] = useState('');
  const now = useNow(500);
  const toolIdx = picked.id === current ? picked.idx : 0;
  const error = failure.id === current ? failure.msg : '';

  const run = async (call: ToolCall, decisionId: string) => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setFailure({ id: current, msg: '' });
    try {
      const msg = await onAct(call, decisionId);
      setFailure({ id: current, msg: msg ?? '' });
      if (!msg) {
        setReceipt(`已提交：${[...(task?.tools ?? []), ...p.interrupts].find((t) => t.name === call.tool)?.title ?? '行动'}。法官已接受。`);
        try { sessionStorage.removeItem(`werewolf.draft:${p.gameId}:${p.me?.seat}:${decisionId}:${call.tool}`); } catch { /* 可继续游戏。 */ }
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  if (p.status === 'ended') return null;
  const interrupts = human && p.me?.alive ? p.interrupts : [];
  if (!task && !interrupts.length) {
    return (
      <div className="panel" id="player-action" aria-label="我的行动">
        <h3>行动</h3>
        {receipt && <div className="note-box small" role="status">{receipt}</div>}
        <div className="muted small">现在不需要你行动。{p.stage ? `当前：${p.stage}。` : ''}</div>
      </div>
    );
  }

  const left = task?.deadline ? Math.max(0, Math.ceil((task.deadline - now) / 1000)) : null;
  const tool = task ? task.tools[Math.min(toolIdx, task.tools.length - 1)] : null;

  return (
    <div className="panel task" id="player-action" aria-label="我的行动">
      {receipt && <div className="note-box small" role="status">{receipt}</div>}
      {task && (
        <>
          <h3>
            {task.title}
            <span className="spacer" />
            {task.simultaneous && <span className="tag">同时行动</span>}
            {left !== null && !task.submitted && !paused && (
              <span className={`countdown ${left <= 15 ? 'urgent' : ''}`}>
                {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
              </span>
            )}
          </h3>
          <div className="prompt">{task.prompt}</div>
          {task.submitted ? (
            <div className="note-box">
              {task.submittedText ?? '已提交。'}
              {task.simultaneous ? ' 等待其他玩家提交…' : ''}
            </div>
          ) : !human ? (
            <div className="note-box">这个座位由 AI 控制，正在等待模型行动。</div>
          ) : (
            <>
              {task.tools.length > 1 && (
                <div className="seg" style={{ marginBottom: 12 }}>
                  {task.tools.map((t, i) => (
                    <button key={t.name} className={tool === t ? 'on' : ''} onClick={() => setPicked({ id: current, idx: i })}>
                      {t.title}
                    </button>
                  ))}
                </div>
              )}
              {tool && (
                <ToolForm
                  key={`${task.decisionId}:${tool.name}`}
                  tool={tool}
                  draftKey={`werewolf.draft:${p.gameId}:${p.me?.seat}:${task.decisionId}:${tool.name}`}
                  busy={busy}
                  disabled={paused}
                  onSubmit={(call) => run(call, task.decisionId)}
                />
              )}
              {paused && <div className="small muted" style={{ marginTop: 8 }}>对局已暂停，恢复后才能提交。</div>}
            </>
          )}
        </>
      )}
      {interrupts.map((t) => (
        <div key={t.name} style={{ marginTop: task ? 14 : 0, paddingTop: task ? 12 : 0, borderTop: task ? '1px dashed var(--line)' : 0 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>随时可用</div>
          <ToolForm key={`intr:${p.actionWindowId ?? ''}:${t.name}`} tool={t} busy={busy} disabled={paused || !p.actionWindowId} onSubmit={(call) => { if (p.actionWindowId) return run(call, p.actionWindowId); }} />
        </div>
      ))}
      {error && (
        <div className="error-box small" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </div>
  );
}
