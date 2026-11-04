import { useI18n } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PROTOCOLS, API_PROTOCOL_LABELS, type ApiProtocol, type ModelPresetView } from '@werewolf/protocol';
import { api } from '../api';
import { ModelList } from './ModelList';

export function ModelLibrary() {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [keySource, setKeySource] = useState<'key' | 'env'>('key');
  const [originalKeySource, setOriginalKeySource] = useState<'key' | 'env'>('key');
  const [envOptions, setEnvOptions] = useState<{ name: string; available: boolean }[]>([]);
  const [protocol, setProtocol] = useState<ApiProtocol>('chat_completions');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<ModelPresetView[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const onChange = useCallback(() => { void api.modelPresets().then(setModels, (e: Error) => setError(e.message)); }, []);
  useEffect(onChange, [onChange]);
  useEffect(() => {
    if (keySource !== 'env') return;
    let active = true;
    void api.modelKeyEnvs().then((result) => { if (active) setEnvOptions(result.variables); }, (e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [keySource]);
  const reset = () => { setEditing(null); setName(''); setBaseUrl(''); setApiKey(''); setApiKeyEnv(''); setKeySource('key'); setOriginalKeySource('key'); setProtocol('chat_completions'); };
  const edit = (model: ModelPresetView) => {
    setEditing(model.id); setName(model.model); setBaseUrl(model.baseUrl); setProtocol(model.apiProtocol ?? 'chat_completions'); setApiKey(''); setError(null); setNotice(null);
    const source = model.apiKeyEnv ? 'env' : 'key'; setKeySource(source); setOriginalKeySource(source); setApiKeyEnv(model.apiKeyEnv ?? '');
    nameInput.current?.focus();
  };
  const add = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const draft = { name: name.trim(), baseUrl: baseUrl.trim(), ...(keySource === 'env' ? { apiKeyEnv: apiKeyEnv.trim() } : { apiKey: apiKey.trim() }), apiProtocol: protocol };
      const saved = editing ? await api.updateModel(editing, draft) : await api.addModel(draft);
      setNotice(t(editing ? '已更新模型「{0}」。' : '已添加模型「{0}」。', saved.model));
      reset();
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
    const model = models.find((item) => item.id === id);
    setBusy(true);
    try {
      await api.deleteModel(id);
      if (editing === id) reset();
      setNotice(t('已从模型库移除「{0}」。', model?.model ?? id));
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <div className="panel">
      <h3>{t('模型库')}</h3>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        {t('在这里添加一次，各房间的座位都可选用。导入的旧模型与新增模型保存在同一个项目模型库。')}
      </p>
      {editing && <p className="small">{t('正在编辑模型，修改后点击保存。')}</p>}
      <div className="model-add">
        <label className="field">
          {t('接口协议')}
          <select value={protocol} onChange={(e) => setProtocol(e.target.value as ApiProtocol)}>
            {API_PROTOCOLS.map((p) => <option key={p} value={p}>{API_PROTOCOL_LABELS[p]}</option>)}
          </select>
        </label>
        <label className="field">
          {t('名称')}
          <input ref={nameInput} type="text" value={name} maxLength={120} placeholder={t('例如 deepseek-v4-flash')} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          {t('baseURL')}
          <input type="text" value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <div className="model-credentials">
          <label className="field">
            {t('密钥来源')}
            <select value={keySource} onChange={(e) => setKeySource(e.target.value as 'key' | 'env')}>
              <option value="key">{t('直接填写密钥')}</option>
              <option value="env">{t('环境变量')}</option>
            </select>
          </label>
          {keySource === 'env' ? <label className="field">
            {t('密钥')}
            <select value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)}>
              <option value="">{t('选择密钥')}</option>
              {apiKeyEnv && !envOptions.some((item) => item.name === apiKeyEnv) && <option value={apiKeyEnv}>{apiKeyEnv} · {t('不在配置列表中')}</option>}
              {envOptions.map((item) => <option key={item.name} value={item.name}>{item.name}{item.available ? '' : ` · ${t('未设置')}`}</option>)}
            </select>
          </label> : <label className="field">
            {t('密钥')}
            <input type="password" name="model-api-key" autoComplete="new-password" value={apiKey} placeholder={editing && originalKeySource === 'key' ? t('留空保留已有密钥') : undefined} onChange={(e) => setApiKey(e.target.value)} />
          </label>}
        </div>
        <div className="row">
          <button className="btn sm primary" disabled={busy || !name.trim() || !baseUrl.trim() || (keySource === 'env' ? !apiKeyEnv.trim() : (!editing || originalKeySource !== 'key') && !apiKey.trim())} onClick={() => void add()}>
            {busy ? t('保存中…') : editing ? t('保存修改') : t('添加')}
          </button>
          {editing && <button className="btn sm" disabled={busy} onClick={reset}>{t('取消')}</button>}
        </div>
      </div>
      {error && <div className="error-box small" style={{ marginTop: 8 }}>{error}</div>}
      {notice && <div className="small muted model-notice" role="status">{notice}</div>}
      {keySource === 'env' && <p className="tiny dim">{t('先在项目数据目录的 model-key-envs.json 添加变量名，并在启动服务的环境中设置变量值；修改变量值后重启服务。')}</p>}
      <ModelList models={models} onEdit={edit} onRemove={remove} busy={busy} />
      <div className="tiny dim" style={{ marginTop: 8 }}>
        {t('添加、编辑或删除请在运行服务的电脑上通过 127.0.0.1 打开页面。删除会从列表移除模型，保留历史对局和密钥。')}
      </div>
    </div>
  );
}

