import { useI18n } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { API_PROTOCOLS, API_PROTOCOL_LABELS, type ApiProtocol, type ModelPresetView } from '@werewolf/protocol';
import { api } from '../api';
import { ModelList } from './ModelList';

export function ModelLibrary() {
  const { t } = useI18n();
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
      setNotice(t('已添加模型「{0}」。', added.label));
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = (id: string) => {
    setError(null);
    const model = models.find((item) => item.id === id);
    setNotice(t('「{0}」的停用、归档、恢复和别名归并需先停止服务，再按 README 的本机维护说明操作。维护会先检查房间引用，归档保留密钥和历史对局。', model?.label ?? id));
  };
  return (
    <div className="panel">
      <h3>{t('模型库')}</h3>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        {t('在这里添加一次，各房间的座位都可选用。导入的旧模型与新增模型保存在同一个项目模型库。')}
      </p>
      <div className="model-add">
        <label className="field">
          {t('接口协议')}
          <select value={protocol} onChange={(e) => setProtocol(e.target.value as ApiProtocol)}>
            {API_PROTOCOLS.map((p) => <option key={p} value={p}>{API_PROTOCOL_LABELS[p]}</option>)}
          </select>
        </label>
        <label className="field">
          {t('名称')}
          <input type="text" value={name} maxLength={120} placeholder={t('例如 deepseek-v4-flash')} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          {t('接口地址')}
          <input type="text" value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className="field">
          {t('密钥')}
          <input type="password" name="model-api-key" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </label>
        <button className="btn sm primary" disabled={busy || !name.trim() || !baseUrl.trim() || !apiKey.trim()} onClick={() => void add()}>
          {busy ? t('添加中…') : t('添加')}
        </button>
      </div>
      {error && <div className="error-box small" style={{ marginTop: 8 }}>{error}</div>}
      {notice && <div className="small muted model-notice" role="status">{notice}</div>}
      <ModelList models={models} onRemove={remove} />
      <div className="tiny dim" style={{ marginTop: 8 }}>
        {t('模型与密钥由当前项目管理，不再实时读取 Qwen Code 的全局配置。清理模型前请停止服务并按 README 执行本机维护。')}
      </div>
    </div>
  );
}

