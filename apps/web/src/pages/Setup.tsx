import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Catalog,
  RoomSetupInput,
  RoomSetupView,
  RuleOptionInfo,
  RuleValue,
  SeatConfigInput,
  SeatConfigView,
} from '@werewolf/protocol';
import { api } from '../api';
import { useCatalog } from '../hooks';
import { RuleCard } from '../components/Cards';
import { copyText, link, seatName } from '../util';

function mergeInput(a: RoomSetupInput, b: RoomSetupInput): RoomSetupInput {
  const seats = new Map((a.seats ?? []).map((s) => [s.seat, s]));
  for (const s of b.seats ?? []) seats.set(s.seat, { ...seats.get(s.seat), ...s });
  return {
    ...a,
    ...b,
    ruleValues: a.ruleValues || b.ruleValues ? { ...a.ruleValues, ...b.ruleValues } : undefined,
    seats: seats.size ? [...seats.values()] : undefined,
  };
}

function applyLocal(s: RoomSetupView, input: RoomSetupInput): RoomSetupView {
  return {
    ...s,
    ruleValues: { ...s.ruleValues, ...input.ruleValues },
    humanTimeoutSec: input.humanTimeoutSec ?? s.humanTimeoutSec,
    aiPacingMs: input.aiPacingMs ?? s.aiPacingMs,
    seats: s.seats.map((seat) => {
      const change = input.seats?.find((x) => x.seat === seat.seat);
      if (!change) return seat;
      const { apiKey: _key, ...rest } = change;
      return { ...seat, ...rest };
    }),
  };
}

/** 开局配置：版型、可改规则、座位（真人 / 模型及其接口）。改动自动保存。 */
export function Setup({ roomId, token, onStarted }: { roomId: string; token: string; onStarted: () => void }) {
  const catalog = useCatalog();
  const [setup, setSetup] = useState<RoomSetupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const queued = useRef<RoomSetupInput>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edits = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    api.getSetup(roomId, token).then(setSetup, (e: Error) => setError(e.message));
  }, [roomId, token]);

  /** 保存请求串行发送，后发的改动不会被先返回的旧结果覆盖。 */
  const flush = useCallback((): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const run = async () => {
      const input = queued.current;
      if (!Object.keys(input).length) return;
      queued.current = {};
      const mark = edits.current;
      setSaving(true);
      try {
        const v = await api.putSetup(roomId, token, input);
        setSetup((cur) =>
          edits.current === mark || !cur
            ? v
            : { ...cur, ruleCardPreview: v.ruleCardPreview, validationErrors: v.validationErrors, tokens: v.tokens },
        );
        setError(null);
      } catch (e) {
        setError((e as Error).message);
        api.getSetup(roomId, token).then(setSetup, () => {});
      } finally {
        setSaving(false);
      }
    };
    chain.current = chain.current.then(run, run);
    return chain.current;
  }, [roomId, token]);

  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  const patch = (input: RoomSetupInput, delay = 500) => {
    edits.current += 1;
    setSetup((s) => (s ? applyLocal(s, input) : s));
    queued.current = mergeInput(queued.current, input);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);
  };

  const patchSeat = (seat: number, change: Omit<SeatConfigInput, 'seat'>, delay?: number) =>
    patch({ seats: [{ seat, ...change }] }, delay);

  const changePreset = async (presetId: string) => {
    await flush();
    queued.current = { presetId };
    await flush();
  };

  const start = async () => {
    setStarting(true);
    try {
      await flush();
      await api.start(roomId, token);
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  if (!setup || !catalog) {
    return <div className="center-screen muted">{error ?? '正在加载房间配置…'}</div>;
  }

  const preset = catalog.presets.find((p) => p.id === setup.presetId);
  const errors = setup.validationErrors;

  return (
    <div className="wrap">
      <div className="setup-grid">
        <div style={{ display: 'grid', gap: 16 }}>
          <PresetPicker catalog={catalog} value={setup.presetId} onChange={(id) => void changePreset(id)} />
          <OptionsPanel catalog={catalog} roles={preset?.roles ?? []} values={setup.ruleValues} onChange={(k, v) => patch({ ruleValues: { [k]: v } }, 200)} />
          <SeatsPanel setup={setup} catalog={catalog} roomId={roomId} token={token} patchSeat={patchSeat} patch={patch} flush={flush} />
        </div>

        <div style={{ display: 'grid', gap: 16, position: 'sticky', top: 70 }}>
          <div className="panel">
            <h3>
              开局
              <span className="spacer" />
              <span className="tiny dim">{saving ? '保存中…' : '已自动保存'}</span>
            </h3>
            <div className="small muted" style={{ marginBottom: 10 }}>
              {preset ? `${preset.name} · ${preset.playerCount} 人` : setup.presetId} · 身份在开局时随机发放
            </div>
            {errors.length > 0 && (
              <div className="error-box small" style={{ marginBottom: 10 }}>
                {errors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}
            {error && (
              <div className="error-box small" style={{ marginBottom: 10 }}>
                {error}
              </div>
            )}
            <button className="btn primary lg" style={{ width: '100%' }} disabled={!!errors.length || starting} onClick={start}>
              {starting ? '正在开局…' : '开始游戏'}
            </button>
          </div>
          <LinksPanel roomId={roomId} setup={setup} />
          <RuleCard text={setup.ruleCardPreview} />
        </div>
      </div>
    </div>
  );
}

function PresetPicker({ catalog, value, onChange }: { catalog: Catalog; value: string; onChange: (id: string) => void }) {
  const roleName = (id: string) => catalog.roles.find((r) => r.id === id)?.name ?? id;
  return (
    <div className="panel">
      <h3>版型</h3>
      <div className="preset-cards">
        {catalog.presets.map((p) => {
          const counts = new Map<string, number>();
          for (const r of p.roles) counts.set(r, (counts.get(r) ?? 0) + 1);
          return (
            <button key={p.id} className={`preset-card ${p.id === value ? 'on' : ''}`} onClick={() => p.id !== value && onChange(p.id)}>
              <div className="row" style={{ gap: 6 }}>
                <b>{p.name}</b>
                {p.tag && <span className="tag gold">{p.tag}</span>}
                <span className="spacer" />
                <span className="small muted">{p.playerCount} 人</span>
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                {p.description}
              </div>
              <div className="roles">
                {[...counts].map(([id, n]) => (
                  <span key={id} className="tag">
                    {roleName(id)}
                    {n > 1 ? ` ×${n}` : ''}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OptionInput({ o, value, onChange }: { o: RuleOptionInfo; value: RuleValue; onChange: (v: RuleValue) => void }) {
  if (o.type === 'boolean') {
    return (
      <div className="seg">
        <button className={value === true ? 'on' : ''} onClick={() => onChange(true)}>
          是
        </button>
        <button className={value === false ? 'on' : ''} onClick={() => onChange(false)}>
          否
        </button>
      </div>
    );
  }
  if (o.type === 'choice') {
    return (
      <select value={String(value)} onChange={(e) => onChange(o.choices!.find((c) => String(c.value) === e.target.value)!.value)}>
        {o.choices!.map((c) => (
          <option key={String(c.value)} value={String(c.value)}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }
  return <input type="number" value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />;
}

function OptionsPanel({
  catalog,
  roles,
  values,
  onChange,
}: {
  catalog: Catalog;
  roles: string[];
  values: Record<string, RuleValue>;
  onChange: (key: string, v: RuleValue) => void;
}) {
  const shown = catalog.options.filter((o) => o.editable && (!o.owner || roles.includes(o.owner)) && values[o.key] !== undefined);
  const groups = [...new Set(shown.map((o) => o.group))];
  return (
    <div className="panel">
      <h3>
        规则选项
        <span className="tiny dim" style={{ fontWeight: 400 }}>
          只列出本版型可以调整的项，其余规则见右侧规则卡
        </span>
      </h3>
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 14 }}>
          <div className="small" style={{ color: 'var(--accent)', marginBottom: 8 }}>
            {g}
          </div>
          <div className="options-grid">
            {shown
              .filter((o) => o.group === g)
              .map((o) => (
                <div key={o.key} className="option">
                  <span className="label">{o.label}</span>
                  <OptionInput o={o} value={values[o.key]} onChange={(v) => onChange(o.key, v)} />
                  {o.hint && <span className="hint">{o.hint}</span>}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface SeatsPanelProps {
  setup: RoomSetupView;
  catalog: Catalog;
  roomId: string;
  token: string;
  patchSeat: (seat: number, change: Omit<SeatConfigInput, 'seat'>, delay?: number) => void;
  patch: (input: RoomSetupInput, delay?: number) => void;
  flush: () => Promise<void>;
}

function SeatsPanel({ setup, catalog, roomId, token, patchSeat, patch, flush }: SeatsPanelProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [batch, setBatch] = useState(false);
  const ai = setup.seats.filter((s) => s.controller === 'ai');
  return (
    <div className="panel">
      <h3>
        座位
        <span className="tiny dim" style={{ fontWeight: 400 }}>
          {ai.length} 个 AI，{setup.seats.length - ai.length} 个真人
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setBatch((x) => !x)}>
          {batch ? '收起批量设置' : '批量设置模型'}
        </button>
      </h3>
      {batch && <BatchForm setup={setup} patch={patch} flush={flush} />}
      <div className="row small muted" style={{ marginBottom: 10 }}>
        <span>真人行动时限（秒，0 为不限时）</span>
        <input
          type="number"
          style={{ width: 90 }}
          value={setup.humanTimeoutSec}
          min={0}
          max={3600}
          onChange={(e) => patch({ humanTimeoutSec: Number(e.target.value) })}
        />
        <span style={{ marginLeft: 12 }}>AI 行动间隔（毫秒）</span>
        <input
          type="number"
          style={{ width: 90 }}
          value={setup.aiPacingMs}
          min={0}
          max={10000}
          step={100}
          onChange={(e) => patch({ aiPacingMs: Number(e.target.value) })}
        />
      </div>
      <div className="seat-table">
        {setup.seats.map((s) => (
          <SeatRow
            key={s.seat}
            s={s}
            catalog={catalog}
            open={open === s.seat}
            onToggle={() => setOpen(open === s.seat ? null : s.seat)}
            patchSeat={patchSeat}
            roomId={roomId}
            token={token}
            flush={flush}
          />
        ))}
      </div>
    </div>
  );
}

function SeatRow({
  s,
  catalog,
  open,
  onToggle,
  patchSeat,
  roomId,
  token,
  flush,
}: {
  s: SeatConfigView;
  catalog: Catalog;
  open: boolean;
  onToggle: () => void;
  patchSeat: SeatsPanelProps['patchSeat'];
  roomId: string;
  token: string;
  flush: () => Promise<void>;
}) {
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const real = s.adapter === 'openai_compatible';
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      await flush();
      const r = await api.testSeat(roomId, token, s.seat);
      setTest({ ok: r.ok, message: `${r.message}${r.latencyMs ? `（${r.latencyMs} ms）` : ''}` });
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };
  const summary =
    s.controller === 'human'
      ? '真人操作：把座位链接发给对应玩家'
      : real
        ? `${s.model || '未填模型'} · ${s.apiKeyMasked ? `密钥 ${s.apiKeyMasked}` : '无密钥'}`
        : '模拟玩家（不联网，用于试玩和测试）';
  return (
    <div className="seat-row">
      <div className="seat-no">{s.seat}</div>
      <input
        type="text"
        value={s.name === seatName(s.seat) ? '' : s.name}
        maxLength={12}
        placeholder={seatName(s.seat)}
        title="座位名字，可以不填"
        onChange={(e) => patchSeat(s.seat, { name: e.target.value })}
      />
      <div className="seg">
        <button className={s.controller === 'ai' ? 'on' : ''} onClick={() => patchSeat(s.seat, { controller: 'ai' }, 0)}>
          AI
        </button>
        <button className={s.controller === 'human' ? 'on' : ''} onClick={() => patchSeat(s.seat, { controller: 'human' }, 0)}>
          真人
        </button>
      </div>
      <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {summary}
      </div>
      {s.controller === 'ai' ? (
        <button className="btn sm" onClick={onToggle}>
          {open ? '收起' : '设置'}
        </button>
      ) : (
        <span />
      )}
      {open && s.controller === 'ai' && (
        <div className="seat-detail">
          <label className="field">
            接入方式
            <select value={s.adapter} onChange={(e) => patchSeat(s.seat, { adapter: e.target.value as SeatConfigView['adapter'] }, 0)}>
              <option value="mock">模拟玩家（不联网）</option>
              <option value="openai_compatible">OpenAI 兼容接口</option>
            </select>
          </label>
          {real && (
            <>
              <label className="field">
                接口地址
                <input type="text" value={s.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => patchSeat(s.seat, { baseUrl: e.target.value })} />
              </label>
              <label className="field">
                模型名
                <input type="text" value={s.model} placeholder="例如 deepseek-chat" onChange={(e) => patchSeat(s.seat, { model: e.target.value })} />
              </label>
              <KeyField masked={s.apiKeyMasked} onCommit={(key) => patchSeat(s.seat, { apiKey: key }, 0)} />
              <label className="field">
                温度
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={s.temperature}
                  onChange={(e) => patchSeat(s.seat, { temperature: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                输出方式
                <select value={s.toolMode} onChange={(e) => patchSeat(s.seat, { toolMode: e.target.value as SeatConfigView['toolMode'] }, 0)}>
                  <option value="tools">工具调用（推荐）</option>
                  <option value="json">JSON 文本（模型不支持工具时）</option>
                </select>
              </label>
              <label className="field">
                单次超时（秒）
                <input type="number" min={5} max={300} value={s.timeoutSec} onChange={(e) => patchSeat(s.seat, { timeoutSec: Number(e.target.value) })} />
              </label>
            </>
          )}
          <label className="field">
            扮演风格
            <select value={s.style} onChange={(e) => patchSeat(s.seat, { style: e.target.value }, 0)}>
              {catalog.styles.map((st) => (
                <option key={st.id} value={st.id} title={st.text}>
                  {st.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            人设补充（可选，只影响说话风格）
            <input type="text" value={s.persona} maxLength={300} onChange={(e) => patchSeat(s.seat, { persona: e.target.value })} />
          </label>
          <div className="row" style={{ gridColumn: '1 / -1' }}>
            <button className="btn sm" disabled={testing} onClick={runTest}>
              {testing ? '测试中…' : '测试连通性'}
            </button>
            {test && <span className={`small ${test.ok ? '' : 'muted'}`} style={{ color: test.ok ? 'var(--good)' : '#ffb3b3' }}>{test.message}</span>}
            {!real && <span className="tiny dim">模拟玩家只根据自己能看到的信息随机做合法决定，用来跑通流程。</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 密钥只写不读：输入后失焦或回车才保存，保存后输入框清空，只显示掩码。 */
function KeyField({ masked, onCommit }: { masked: string | null; onCommit: (key: string | null) => void }) {
  const [value, setValue] = useState('');
  const commit = () => {
    if (!value.trim()) return;
    onCommit(value.trim());
    setValue('');
  };
  return (
    <label className="field">
      API 密钥 {masked && <span className="dim">（已保存 {masked}）</span>}
      <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
        <input
          type="password"
          autoComplete="off"
          value={value}
          placeholder={masked ? '输入新密钥以替换' : '输入后回车保存'}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        {masked && (
          <button className="btn sm ghost" type="button" onClick={() => onCommit(null)}>
            清除
          </button>
        )}
      </div>
    </label>
  );
}

function BatchForm({ setup, patch, flush }: { setup: RoomSetupView; patch: SeatsPanelProps['patch']; flush: () => Promise<void> }) {
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', temperature: 0.7, toolMode: 'tools' as SeatConfigView['toolMode'], timeoutSec: 60 });
  const [done, setDone] = useState<string | null>(null);
  const ai = setup.seats.filter((s) => s.controller === 'ai');
  const apply = async () => {
    const seats: SeatConfigInput[] = ai.map((s) => ({
      seat: s.seat,
      adapter: 'openai_compatible',
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      temperature: form.temperature,
      toolMode: form.toolMode,
      timeoutSec: form.timeoutSec,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    }));
    patch({ seats }, 0);
    await flush();
    setForm((f) => ({ ...f, apiKey: '' }));
    setDone(`已应用到 ${seats.length} 个 AI 座位。`);
  };
  const toMock = async () => {
    patch({ seats: ai.map((s) => ({ seat: s.seat, adapter: 'mock' as const })) }, 0);
    await flush();
    setDone(`${ai.length} 个 AI 座位已改为模拟玩家。`);
  };
  return (
    <div className="note-box" style={{ marginBottom: 12 }}>
      <div className="small" style={{ marginBottom: 8 }}>
        把同一套接口配置应用到所有 AI 座位（之后仍可单独修改某个座位）。
      </div>
      <div className="seat-detail" style={{ borderTop: 0, paddingTop: 0 }}>
        <label className="field">
          接口地址
          <input type="text" value={form.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
        </label>
        <label className="field">
          模型名
          <input type="text" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </label>
        <label className="field">
          API 密钥
          <input type="password" autoComplete="off" value={form.apiKey} placeholder="留空则不改动各座位的密钥" onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
        </label>
        <label className="field">
          温度
          <input type="number" min={0} max={2} step={0.1} value={form.temperature} onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} />
        </label>
        <label className="field">
          输出方式
          <select value={form.toolMode} onChange={(e) => setForm({ ...form, toolMode: e.target.value as SeatConfigView['toolMode'] })}>
            <option value="tools">工具调用（推荐）</option>
            <option value="json">JSON 文本</option>
          </select>
        </label>
        <label className="field">
          单次超时（秒）
          <input type="number" min={5} max={300} value={form.timeoutSec} onChange={(e) => setForm({ ...form, timeoutSec: Number(e.target.value) })} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sm primary" disabled={!form.baseUrl.trim() || !form.model.trim() || !ai.length} onClick={apply}>
          应用到全部 AI 座位
        </button>
        <button className="btn sm" disabled={!ai.length} onClick={toMock}>
          全部改回模拟玩家
        </button>
        {done && <span className="small muted">{done}</span>}
      </div>
    </div>
  );
}

function LinksPanel({ roomId, setup }: { roomId: string; setup: RoomSetupView }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, url: string) => {
    if (await copyText(url)) {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }
  };
  const humans = setup.seats.filter((s) => s.controller === 'human');
  const rows = [
    { key: 'host', label: '房主', url: link('host', roomId, setup.tokens.host) },
    { key: 'watch', label: '观战', url: link('watch', roomId, setup.tokens.spectator) },
    ...setup.tokens.seats.map((t) => ({
      key: `seat${t.seat}`,
      label: `${seatName(t.seat)}${humans.some((h) => h.seat === t.seat) ? '（真人）' : ''}`,
      url: link('seat', roomId, t.token),
    })),
  ];
  return (
    <details className="panel" open={humans.length > 0}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>邀请链接</summary>
      <div className="small muted" style={{ margin: '8px 0' }}>
        链接里带有凭证，等同于身份，只发给对应的人。房主链接能看到全部身份。
      </div>
      <div className="links">
        {rows.map((r) => (
          <div key={r.key} className="link-row">
            <span style={{ width: 82, flexShrink: 0 }}>{r.label}</span>
            <code>{r.url}</code>
            <button className="btn sm" onClick={() => void copy(r.key, r.url)}>
              {copied === r.key ? '已复制' : '复制'}
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}

export { LinksPanel };
