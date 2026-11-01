import { useCallback, useEffect, useRef, useState } from 'react';
import { thinkingOptions, defaultThinkingMode, API_PROTOCOLS, API_PROTOCOL_LABELS, type ApiProtocol } from '@werewolf/protocol';
import type {
  Catalog,
  ModelPresetView,
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
import { Avatar } from '../components/Avatar';
import { copyText, link, seatName, seatStyle } from '../util';

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
      const { apiKey: _key, presetId: _preset, ...rest } = change;
      return { ...seat, ...rest };
    }),
  };
}

/** 开局配置：版型、可改规则、模型名单和座位。改动自动保存。 */
export function Setup({ roomId, token, onStarted }: { roomId: string; token: string; onStarted: () => void }) {
  const catalog = useCatalog();
  const [setup, setSetup] = useState<RoomSetupView | null>(null);
  const [models, setModels] = useState<ModelPresetView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const queued = useRef<RoomSetupInput>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edits = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const loadModels = useCallback(() => {
    api.modelPresets().then(setModels, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    api.getSetup(roomId, token).then(setSetup, (e: Error) => setError(e.message));
  }, [roomId, token]);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

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
      <header className="page-heading">
        <div><span className="eyebrow">PREPARE YOUR COUNCIL</span><h1>准备你的圆桌</h1><p>选一个故事，让不同的声音入席。</p></div>
        <span className="tag gold">{saving ? '正在保存…' : '配置已自动保存'}</span>
      </header>
      <div className="setup-steps"><span><b>01</b>选择版型</span><span><b>02</b>安排座位</span><span><b>03</b>开启故事</span></div>
      <div className="setup-grid">
        <div className="setup-main">
          <PresetPicker catalog={catalog} value={setup.presetId} onChange={(id) => void changePreset(id)} />
          <SeatsPanel
            setup={setup}
            catalog={catalog}
            models={models}
            roomId={roomId}
            token={token}
            patchSeat={patchSeat}
            patch={patch}
            flush={flush}
          />
          <details className="panel setup-advanced">
            <summary>规则与模型设置<small>按需要调整</small></summary>
            <OptionsPanel catalog={catalog} roles={preset?.roles ?? []} values={setup.ruleValues} onChange={(k, v) => patch({ ruleValues: { [k]: v } }, 200)} />
            <ModelsPanel models={models} onChange={loadModels} />
          </details>
        </div>

        <div className="setup-sidebar">
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

function choiceFor(models: ModelPresetView[]) {
  return (id: string): Omit<SeatConfigInput, 'seat'> | null => {
    if (id === 'mock') return { adapter: 'mock', modelId: null };
    const preset = models.find((m) => m.id === id);
    if (!preset) return null;
    return {
      adapter: 'openai_compatible',
      presetId: preset.id,
      modelId: preset.id,
      model: preset.model,
      baseUrl: preset.baseUrl,
      apiProtocol: preset.apiProtocol ?? 'chat_completions',
    };
  };
}

function keepThinking(seat: SeatConfigView, next: Omit<SeatConfigInput, 'seat'>): Omit<SeatConfigInput, 'seat'> {
  const baseUrl = next.baseUrl ?? seat.baseUrl;
  const model = next.model ?? seat.model;
  const protocol = next.apiProtocol ?? seat.apiProtocol;
  const preferred = defaultThinkingMode(baseUrl, model, protocol);
  const mode = seat.thinkingMode ?? preferred;
  const supported = thinkingOptions(baseUrl, model, protocol).some((o) => o.value === mode && o.supported);
  return { ...next, thinkingMode: supported ? mode : preferred };
}

function ModelsPanel({ models, onChange }: { models: ModelPresetView[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<ApiProtocol>('chat_completions');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const added = models.filter((m) => m.source === 'added');
  const fromSettings = models.filter((m) => m.source === 'settings');
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.addModel({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), apiProtocol: protocol });
      setName('');
      setBaseUrl('');
      setApiKey('');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setError(null);
    try {
      await api.deleteModel(id);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="panel">
      <h3>模型</h3>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        选择协议并添加模型，各座位可重复选用。settings.json 中的模型已自动导入，也可在座位设置中调整接口。
      </p>
      <div className="model-add">
        <label className="field">
          接口协议
          <select value={protocol} onChange={(e) => setProtocol(e.target.value as ApiProtocol)}>
            {API_PROTOCOLS.map((p) => <option key={p} value={p}>{API_PROTOCOL_LABELS[p]}</option>)}
          </select>
        </label>
        <label className="field">
          名称
          <input type="text" value={name} maxLength={120} placeholder="例如 deepseek-v4-flash" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          接口地址
          <input type="text" value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className="field">
          密钥
          <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </label>
        <button className="btn sm primary" disabled={busy || !name.trim() || !baseUrl.trim() || !apiKey.trim()} onClick={() => void add()}>
          {busy ? '添加中…' : '添加'}
        </button>
      </div>
      {error && <div className="error-box small" style={{ marginTop: 8 }}>{error}</div>}
      {added.length > 0 && (
        <div className="model-list">
          {added.map((m) => (
            <div key={m.id} className="model-item">
              <span>{m.label} · {API_PROTOCOL_LABELS[m.apiProtocol ?? 'chat_completions']}</span>
              <span className="tiny dim">{m.baseUrl}</span>
              <button className="btn sm ghost" type="button" onClick={() => void remove(m.id)}>
                删除
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="tiny dim" style={{ marginTop: 8 }}>
        {fromSettings.length ? `settings 里有 ${fromSettings.length} 个模型，直接在座位上选。` : 'settings 里没有读到模型。'}
      </div>
    </div>
  );
}

interface SeatsPanelProps {
  setup: RoomSetupView;
  catalog: Catalog;
  models: ModelPresetView[];
  roomId: string;
  token: string;
  patchSeat: (seat: number, change: Omit<SeatConfigInput, 'seat'>, delay?: number) => void;
  patch: (input: RoomSetupInput, delay?: number) => void;
  flush: () => Promise<void>;
}

function SeatsPanel({ setup, catalog, models, roomId, token, patchSeat, patch, flush }: SeatsPanelProps) {
  const [open, setOpen] = useState<number | null>(null);
  const choice = choiceFor(models);
  const ai = setup.seats.filter((s) => s.controller === 'ai');
  const added = models.filter((m) => m.source === 'added');
  const fromSettings = models.filter((m) => m.source === 'settings');
  const applyAll = (id: string) => {
    const picked = choice(id);
    if (!picked) return;
    patch({ seats: ai.map((s) => ({ seat: s.seat, ...keepThinking(s, picked) })) }, 0);
  };
  return (
    <div className="panel">
      <h3>
        座位
        <span className="tiny dim" style={{ fontWeight: 400 }}>
          {ai.length} 个 AI，{setup.seats.length - ai.length} 个真人
        </span>
        <span className="spacer" />
        <select className="seat-model" style={{ maxWidth: 280 }} value="" onChange={(e) => applyAll(e.target.value)}>
          <option value="">全部 AI 座位改成…</option>
          <option value="mock">模拟玩家</option>
          {added.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {API_PROTOCOL_LABELS[m.apiProtocol ?? 'chat_completions']}
            </option>
          ))}
          {fromSettings.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {API_PROTOCOL_LABELS[m.apiProtocol ?? 'chat_completions']}
            </option>
          ))}
        </select>
      </h3>
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
            models={models}
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

function selectedId(s: SeatConfigView, models: ModelPresetView[]): string {
  if (s.adapter !== 'openai_compatible') return 'mock';
  if (s.modelId && models.some((m) => m.id === s.modelId)) return s.modelId;
  return models.find((m) => m.model === s.model && m.baseUrl === s.baseUrl && (m.apiProtocol ?? 'chat_completions') === (s.apiProtocol ?? 'chat_completions'))?.id ?? (s.model ? 'custom' : 'mock');
}

function ModelOptions({ models }: { models: ModelPresetView[] }) {
  const added = models.filter((m) => m.source === 'added');
  const settings = models.filter((m) => m.source === 'settings');
  return (
    <>
      <option value="mock">模拟玩家</option>
      {added.length > 0 && (
        <optgroup label="已添加">
          {added.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {API_PROTOCOL_LABELS[m.apiProtocol ?? 'chat_completions']}
            </option>
          ))}
        </optgroup>
      )}
      {settings.length > 0 && (
        <optgroup label="settings">
          {settings.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {API_PROTOCOL_LABELS[m.apiProtocol ?? 'chat_completions']}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

function SeatRow({
  s,
  catalog,
  models,
  open,
  onToggle,
  patchSeat,
  roomId,
  token,
  flush,
}: {
  s: SeatConfigView;
  catalog: Catalog;
  models: ModelPresetView[];
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
  const providerTemperature = s.apiProtocol === 'anthropic_messages' || (s.apiProtocol === 'responses' && /^(?:gpt-[56]|o[134])(?:[.-]|$)/i.test(s.model));
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
  const value = selectedId(s, models);
  const pick = (id: string) => {
    const next = choiceFor(models)(id);
    if (next) patchSeat(s.seat, keepThinking(s, next), 0);
  };
  const thinking = thinkingOptions(s.baseUrl, s.model, s.apiProtocol);
  const thinkingHint = thinking.find((o) => o.value === (s.thinkingMode ?? 'default'))?.hint;
  return (
    <div className="seat-row">
      <div className="seat-no" style={seatStyle(s.seat)}>
        <Avatar seat={s.seat} size={34} /><b>{s.seat}</b>
      </div>
      <input
        type="text"
        value={s.name === seatName(s.seat) ? '' : s.name}
        maxLength={12}
        placeholder="自定义昵称"
        aria-label={`${s.seat}号的昵称`}
        title="自定义昵称，可在开局前修改"
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
      {s.controller === 'ai' ? (
        <select className="seat-model" value={value} onChange={(e) => pick(e.target.value)}>
          {value === 'custom' && <option value="custom">{s.model || '未选择'}</option>}
          <ModelOptions models={models} />
        </select>
      ) : (
        <div className="small muted">真人操作，把座位链接发给对应玩家</div>
      )}
      {s.controller === 'ai' ? (
        <button className="btn sm" disabled={testing} onClick={() => void runTest()}>
          {testing ? '测通中…' : '测通'}
        </button>
      ) : (
        <span />
      )}
      {s.controller === 'ai' ? (
        <button className="btn sm" onClick={onToggle}>
          {open ? '收起' : '设置'}
        </button>
      ) : (
        <span />
      )}
      {test && (
        <div className="small" style={{ gridColumn: '1 / -1', color: test.ok ? 'var(--good)' : 'var(--wolf-ink)' }}>
          {test.message}
        </div>
      )}
      {open && s.controller === 'ai' && (
        <div className="seat-detail">
          {real && (
            <>
              <label className="field">
                接口协议
                <select value={s.apiProtocol ?? 'chat_completions'} onChange={(e) => patchSeat(s.seat, keepThinking(s, { apiProtocol: e.target.value as ApiProtocol, modelId: null }), 0)}>
                  {API_PROTOCOLS.map((p) => <option key={p} value={p}>{API_PROTOCOL_LABELS[p]}</option>)}
                </select>
              </label>
              <label className="field">
                接口地址
                <input type="text" value={s.baseUrl} onChange={(e) => patchSeat(s.seat, { baseUrl: e.target.value, modelId: null })} />
              </label>
              <label className="field">
                模型名
                <input type="text" value={s.model} onChange={(e) => patchSeat(s.seat, keepThinking(s, { model: e.target.value, modelId: null }))} />
              </label>
              {s.apiProtocol && s.apiProtocol !== 'chat_completions' && <label className="field" title="按供应商定义计数，部分接口把思考也计入上限。">
                输出 token 上限
                <input type="number" min={1024} max={128000} step={1024} value={s.maxOutputTokens ?? 32768} onChange={(e) => patchSeat(s.seat, { maxOutputTokens: Number(e.target.value) })} />
              </label>}
              <label className="field">
                温度
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={s.temperature}
                  disabled={providerTemperature}
                  title={providerTemperature ? '当前协议配置使用供应商默认温度。' : undefined}
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
                技能与旁听超时（秒）
                <input type="number" min={90} max={300} value={s.timeoutSec} onChange={(e) => patchSeat(s.seat, { timeoutSec: Number(e.target.value) })} />
              </label>
              <div className="field thinking-field">
                <span id={`thinking-label-${s.seat}`}>思考强度</span>
                <div className="seg thinking-levels" role="group" aria-labelledby={`thinking-label-${s.seat}`}>
                  {thinking.map((o) => (
                    <button key={o.value} type="button" className={(s.thinkingMode ?? 'default') === o.value ? 'on' : ''}
                      aria-pressed={(s.thinkingMode ?? 'default') === o.value} disabled={!o.supported} title={o.hint}
                      onClick={() => patchSeat(s.seat, { thinkingMode: o.value }, 0)}>
                      {o.label}
                    </button>
                  ))}
                </div>
                <span className="tiny dim">{thinkingHint}</span>
              </div>
              <span className="tiny dim" style={{ gridColumn: '1 / -1' }}>发言限时 180 秒，投票限时 90 秒。思考越深入通常等待越久，仍须在行动时限内完成。</span>
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
          {!real && <span className="tiny dim" style={{ gridColumn: '1 / -1' }}>模拟玩家不联网。选了名单里的模型之后，用这一行的「测通」检查。</span>}
        </div>
      )}
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
