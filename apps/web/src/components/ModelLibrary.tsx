import { useCallback, useEffect, useState } from 'react';
import { API_PROTOCOLS, API_PROTOCOL_LABELS, type ApiProtocol, type ModelPresetView } from '@werewolf/protocol';
import { api } from '../api';
import { ModelList } from './ModelList';

export function ModelLibrary() {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<ApiProtocol>('chat_completions');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<ModelPresetView[]>([]);
  const onChange = useCallback(() => { void api.modelPresets().then(setModels, (e: Error) => setError(e.message)); }, []);
  useEffect(onChange, [onChange]);
  const add = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const added = await api.addModel({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), apiProtocol: protocol });
      setName('');
      setBaseUrl('');
      setApiKey('');
      setNotice(`已添加模型「${added.label}」。`);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setError(null);
    setNotice(null);
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
      {notice && <div className="small muted model-notice" role="status">{notice}</div>}
      <ModelList models={models} onRemove={remove} />
      <div className="tiny dim" style={{ marginTop: 8 }}>
        模型与密钥由当前项目管理，不再实时读取 Qwen Code 的全局配置。
      </div>
    </div>
  );
}

