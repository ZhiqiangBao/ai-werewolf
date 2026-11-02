import { useEffect, useRef, useState } from 'react';
import { SPEECH_CONNECTION_TEMPLATES, type SpeechConnectionDraft, type SpeechConnectionKind, type SpeechConnectionView, type SpeechSettingsView } from '@werewolf/protocol';
import { api } from '../api';

const empty = (): SpeechConnectionDraft => ({ kind: 'speech-compatible', name: '', url: '', apiKey: '', model: '', voice: '' });
export function SpeechSettings({ roomId, token }: { roomId: string; token: string }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<SpeechSettingsView | null>(null);
  const [draft, setDraft] = useState(empty), [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [sample, setSample] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    dialog.current?.showModal();
    void api.speechSettings(roomId, token).then((value) => { if (active) { setData(value); setError(value.error ?? ''); } }, (e: Error) => { if (active) setError(e.message); });
    return () => { active = false; controller.current?.abort(); };
  }, [open, roomId, token]);
  useEffect(() => () => { if (sample) URL.revokeObjectURL(sample); }, [sample]);
  const patch = (value: Partial<SpeechConnectionDraft>) => setDraft((current) => ({ ...current, ...value }));
  const reset = () => { setEditing(undefined); setDraft(empty()); };
  const close = () => { controller.current?.abort(); dialog.current?.close(); setOpen(false); setSample(''); setBusy(false); setError(''); setNotice(''); reset(); };
  const changed = async () => {
    setData(await api.speechSettings(roomId, token));
    window.dispatchEvent(new CustomEvent('werewolf-speech-providers-updated', { detail: roomId }));
  };
  const selectKind = (kind: SpeechConnectionKind) => {
    const template = SPEECH_CONNECTION_TEMPLATES.find((item) => item.kind === kind)!;
    patch({ kind, url: template.url, model: template.model, voice: template.voice, bodyJson: '{\n  "text": "{{text}}"\n}', audioPath: 'audio', encoding: 'base64', mimeType: undefined, apiKeyHeader: undefined, apiKeyPrefix: undefined });
  };
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try { await api.saveSpeech(roomId, token, draft, editing); reset(); await changed(); setNotice('已保存，可在朗读来源中选择。'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const edit = (connection: SpeechConnectionView) => {
    const { hasKey: _hasKey, id, ...fields } = connection;
    controller.current?.abort(); setBusy(false); setSample(''); setError(''); setNotice('');
    setEditing(id); setDraft({ ...fields, apiKey: '' });
  };
  const remove = async (id: string) => {
    setBusy(true); setError(''); setNotice(''); setSample('');
    try { await api.deleteSpeech(roomId, token, id); if (editing === id) reset(); await changed(); setNotice('已删除此朗读来源。'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const test = async (id: string) => {
    controller.current?.abort(); const own = new AbortController(); controller.current = own;
    setBusy(true); setError(''); setNotice(''); setSample('');
    try {
      const response = await fetch(`/api/v1/rooms/${roomId}/speech-settings/${encodeURIComponent(id)}/test`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: own.signal });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw Error(body.message ?? '试听失败'); }
      const blob = await response.blob();
      if (!own.signal.aborted) { setSample(URL.createObjectURL(blob)); setNotice('试听音频已生成，请点击播放器播放。'); }
    } catch (e) { if (!own.signal.aborted) setError((e as Error).message); }
    finally { if (!own.signal.aborted) setBusy(false); }
  };
  const custom = draft.kind === 'http-audio' || draft.kind === 'http-json-audio';
  return <>
    <button className="btn sm" onClick={() => setOpen(true)}>TTS 设置</button>
    <dialog ref={dialog} className="speech-settings" aria-labelledby="speech-settings-title" onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="row"><div><h2 id="speech-settings-title">语音服务</h2><p className="small muted">为本房间添加朗读来源。保存后可选择使用，试听会向所填服务发送一条固定测试句。</p></div><button className="btn sm" onClick={close} aria-label="关闭 TTS 设置">关闭</button></div>
      {data?.builtins.length ? <p className="small muted">已有来源：{data.builtins.map((item) => item.label).join('、')}</p> : null}
      <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy || !!data?.error}>
          <div className="speech-settings-grid">
            <label className="field">接入类型<select value={draft.kind} onChange={(e) => selectKind(e.target.value as SpeechConnectionKind)}>{SPEECH_CONNECTION_TEMPLATES.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label>
            <label className="field">名称<input required maxLength={120} value={draft.name} placeholder="例如：我的语音服务" onChange={(e) => patch({ name: e.target.value })} /></label>
            <label className="field speech-settings-wide">接口 URL<input required type="url" value={draft.url} placeholder="https://你的服务地址/v1/audio/speech" onChange={(e) => patch({ url: e.target.value })} /></label>
            <label className="field speech-settings-wide">API Key<input name="tts-api-key" type="password" autoComplete="new-password" required={!editing} value={draft.apiKey ?? ''} placeholder={editing ? '留空保留已有密钥' : '输入服务商的 API Key'} onChange={(e) => patch({ apiKey: e.target.value })} /></label>
            {!custom && <>
              <label className="field">模型 ID<input value={draft.model ?? ''} placeholder="接口有默认值时可留空" onChange={(e) => patch({ model: e.target.value })} /></label>
              <label className="field">音色 ID<input value={draft.voice ?? ''} placeholder="按服务商音色列表填写" onChange={(e) => patch({ voice: e.target.value })} /></label>
            </>}
          </div>
          <p className="tiny muted">{draft.kind === 'speech-compatible' ? '填写完整语音合成地址；模型、音色是否必填取决于服务商。名称只用于显示。' : draft.kind === 'qwen' ? '填写 Qwen SpeechSynthesizer 完整地址及对应线路的 Key；不会自动换计费线路。' : draft.kind === 'mimo' ? '使用小米的 OpenAI 兼容语音地址；支持预置音色。Token Plan 的使用范围以服务商说明为准。' : draft.kind === 'minimax' ? '使用 MiniMax 同步语音合成地址；模板按非流式 MP3 配置。' : '把 {{text}} 放在 JSON 模板的字符串中，发送时会替换为已授权的原文。'}</p>
          {draft.kind !== 'qwen' && <details className="speech-settings-advanced" open={custom}>
            <summary>高级设置</summary>
            <div className="speech-settings-grid">
              <label className="field">密钥请求头<input value={draft.apiKeyHeader ?? 'Authorization'} onChange={(e) => patch({ apiKeyHeader: e.target.value })} /></label>
              <label className="field">密钥前缀<input value={draft.apiKeyPrefix ?? 'Bearer '} onChange={(e) => patch({ apiKeyPrefix: e.target.value })} /></label>
              {custom && <label className="field speech-settings-wide">请求 JSON 模板<textarea rows={6} value={draft.bodyJson ?? ''} onChange={(e) => patch({ bodyJson: e.target.value })} spellCheck={false} /></label>}
              {draft.kind === 'http-json-audio' && <>
                <label className="field">音频字段路径<input value={draft.audioPath ?? 'audio'} placeholder="例如 data.audio" onChange={(e) => patch({ audioPath: e.target.value })} /></label>
                <label className="field">音频编码<select value={draft.encoding ?? 'base64'} onChange={(e) => patch({ encoding: e.target.value as 'base64' | 'hex' })}><option value="base64">Base64</option><option value="hex">Hex</option></select></label>
              </>}
              {custom && <label className="field">音频类型<select value={draft.mimeType ?? ''} onChange={(e) => patch({ mimeType: e.target.value || undefined })}><option value="">{draft.kind === 'http-json-audio' ? 'WAV（默认）' : '使用响应 Content-Type'}</option>{['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/flac'].map((type) => <option key={type} value={type}>{type}</option>)}</select></label>}
            </div>
          </details>}
          <div className="row"><button className="btn primary sm" type="submit">{busy ? '处理中…' : editing ? '保存修改' : '添加来源'}</button>{editing && <button className="btn sm" type="button" onClick={reset}>取消编辑</button>}</div>
        </fieldset>
      </form>
      {error && <div className="error-box small" role="alert">{error}</div>}
      {notice && <p className="small" role="status">{notice}</p>}
      {sample && <audio controls src={sample} aria-label="TTS 试听音频" />}
      <div className="speech-settings-list">{data?.connections.map((item) => <article key={item.id}>
        <div><b>{item.name}</b><span className="tiny muted">{SPEECH_CONNECTION_TEMPLATES.find((template) => template.kind === item.kind)?.label} · {item.hasKey ? '已保存密钥' : '密钥不可用'}</span><span className="tiny muted">{item.url}</span></div>
        <div className="row"><button className="btn sm" disabled={busy || !item.hasKey} onClick={() => void test(item.id)} aria-label={`试听 ${item.name}`}>试听</button><button className="btn sm" disabled={busy} onClick={() => edit(item)} aria-label={`编辑 ${item.name}`}>编辑</button><button className="btn sm ghost" disabled={busy} onClick={() => void remove(item.id)} aria-label={`删除 ${item.name}`}>删除</button></div>
      </article>)}</div>
      <p className="tiny muted">密钥加密保存在服务端，玩家与观战页只获得来源名称。更换配置后，其他已打开的页面刷新即可看到。</p>
    </dialog>
  </>;
}
