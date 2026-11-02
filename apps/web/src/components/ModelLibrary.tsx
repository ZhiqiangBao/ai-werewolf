import { useCallback, useEffect, useState } from 'react';
import { API_PROTOCOLS, API_PROTOCOL_LABELS, type ApiProtocol, type ModelPresetView } from '@werewolf/protocol';
import { api } from '../api';

export function ModelLibrary() {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<ApiProtocol>('chat_completions');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelPresetView[]>([]);
  const onChange = useCallback(() => { void api.modelPresets().then(setModels, (e: Error) => setError(e.message)); }, []);
  useEffect(onChange, [onChange]);
  const added = models;
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
      <h3>模型库</h3>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        在这里添加一次，各房间的座位都可选用。导入的旧模型与新增模型保存在同一个项目模型库。
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
          <input type="password" name="model-api-key" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
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
              <span>{m.label} · {API_PROTOCOL_LABELS[m.apiProtocol ?? 'chat_completions']}{m.source !== 'added' ? ' · 已迁移' : ''}{!m.hasKey ? ' · 未配置密钥' : ''}</span>
              <span className="tiny dim">{m.baseUrl}</span>
              <button className="btn sm ghost" type="button" onClick={() => void remove(m.id)}>
                删除
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="tiny dim" style={{ marginTop: 8 }}>
        模型与密钥由当前项目管理，不再实时读取 Qwen Code 的全局配置。
      </div>
    </div>
  );
}

