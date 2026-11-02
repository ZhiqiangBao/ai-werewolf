import { useEffect, useRef, useState } from 'react';
import type { GameEvent, Projection, SpeechProviderView } from '@werewolf/protocol';
import { api } from '../api';
import { audibleSpeech, SpeechCursor, type SpeechItem } from '../speech';
import { browserSpeechOutput, serverSpeechOutput, type SpeechOutput } from '../speech-output';

export function useSpeechPlayback(roomId: string, token: string, projection: Projection | null) {
  const [enabled, setEnabled] = useState(false), [paused, setPaused] = useState(false);
  const [current, setCurrent] = useState<SpeechItem | null>(null), [queue, setQueue] = useState<SpeechItem[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [rate, setRate] = useState(1);
  const [providers, setProviders] = useState<SpeechProviderView[]>([]), [providerError, setProviderError] = useState('');
  const [source, setSource] = useState(''), [voice, setVoice] = useState(''), [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const native = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
  const audio = useRef<HTMLAudioElement | null>(null), output = useRef<SpeechOutput | null>(null);
  const cursor = useRef(new SpeechCursor()), enabledRef = useRef(false), pausedRef = useRef(false), rateRef = useRef(rate);
  const sourceRef = useRef(source), stopRef = useRef<() => void>(() => {});
  sourceRef.current = source;
  rateRef.current = rate;
  const items = audibleSpeech(projection?.events ?? []);

  useEffect(() => {
    if (!native) return;
    const refresh = () => setVoices(window.speechSynthesis.getVoices());
    refresh(); window.speechSynthesis.addEventListener('voiceschanged', refresh);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh);
  }, [native]);
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = (initial = false) => {
      const own = ++request;
      void api.speechProviders(roomId, token).then((data) => {
        if (!active || own !== request) return;
        setProviders(data.providers); setProviderError(data.error ?? '');
        if (!initial && sourceRef.current) {
          if (sourceRef.current !== 'browser' && !data.providers.some((p) => p.id === sourceRef.current)) {
            stopRef.current(); setSource(''); setError('所选朗读来源已删除，请重新选择。');
          }
          return;
        }
        const preferred = localStorage.getItem('werewolf-speech-source');
        setSource(preferred === 'browser' && native ? 'browser' : data.providers.some((p) => p.id === preferred) ? preferred! : native ? 'browser' : data.defaultProviderId ?? '');
      }, () => { if (active && own === request) { setProviderError('无法载入服务端朗读来源。'); if (initial && native) setSource('browser'); } });
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail !== roomId) return;
      if (sourceRef.current.startsWith('tts_')) stopRef.current();
      refresh();
    };
    const focus = () => refresh();
    refresh(true);
    window.addEventListener('werewolf-speech-providers-updated', changed); window.addEventListener('focus', focus);
    return () => { active = false; window.removeEventListener('werewolf-speech-providers-updated', changed); window.removeEventListener('focus', focus); };
  }, [roomId, token, native]);
  useEffect(() => {
    if (!projection) return;
    const fresh = cursor.current.sync(audibleSpeech(projection.events), enabledRef.current);
    if (fresh.length) setQueue((q) => [...q, ...fresh]);
  }, [projection]);
  useEffect(() => {
    if (current || paused || !queue.length) return;
    setCurrent(queue[0]); setQueue((q) => q.slice(1));
  }, [current, paused, queue]);
  useEffect(() => {
    if (!current || !source) return;
    let active = true;
    const fail = (message: string) => {
      if (!active) return;
      setError(message); setLoading(false); enabledRef.current = false; setEnabled(false); setQueue([]); setCurrent(null);
    };
    if (source === 'browser' && !native) { fail('当前浏览器不支持原生朗读，请选择其他来源。'); return; }
    audio.current ??= new Audio();
    const driver = source === 'browser'
      ? browserSpeechOutput(window.speechSynthesis, () => new SpeechSynthesisUtterance(), voice)
      : serverSpeechOutput(audio.current, roomId, token, source);
    output.current = driver; setLoading(true); setError('');
    void driver.play(current, rateRef.current, {
      ready: () => { if (active) setLoading(false); },
      ended: () => { if (active) setCurrent(null); },
      blocked: (message) => { if (active) { pausedRef.current = true; setPaused(true); setError(message); } },
      failed: fail,
    }).catch((e: Error) => fail(e.message));
    if (pausedRef.current) driver.pause();
    return () => { active = false; driver.stop(); if (output.current === driver) output.current = null; };
  }, [current, source, voice, roomId, token, native]);
  useEffect(() => { output.current?.setRate(rate); }, [rate]);
  useEffect(() => () => { output.current?.stop(); }, []);

  const stop = () => {
    enabledRef.current = false; pausedRef.current = false;
    setEnabled(false); setPaused(false); setCurrent(null); setQueue([]); setLoading(false); output.current?.stop();
  };
  stopRef.current = stop;
  const read = (event: GameEvent) => {
    const item = audibleSpeech([event])[0];
    if (!item) return;
    if (!source) { setError('请先选择可用的朗读来源。'); return; }
    pausedRef.current = false; setPaused(false); setQueue([]); setCurrent({ ...item });
  };
  const resume = async () => {
    pausedRef.current = false; setPaused(false); setError('');
    try { await output.current?.resume(); }
    catch { pausedRef.current = true; setPaused(true); setError('浏览器未能播放，请再次点击继续。'); }
  };
  const start = () => {
    if (!source) { setError('请先选择可用的朗读来源。'); return; }
    // 与点击时的快照对齐，防止尚未运行的投影 effect 把刚选中的最新一条再次入队。
    cursor.current.sync(items, false);
    enabledRef.current = true; setEnabled(true); setError('');
    if (current) void resume();
    else { pausedRef.current = false; setPaused(false); if (items.length) setCurrent({ ...items[items.length - 1] }); }
  };
  const togglePause = () => {
    if (pausedRef.current) return resume();
    pausedRef.current = true; setPaused(true); output.current?.pause();
  };
  const changeSource = (value: string) => { stop(); setSource(value); setError(''); localStorage.setItem('werewolf-speech-source', value); };
  const changeVoice = (value: string) => { stop(); setVoice(value); setError(''); };
  return { audio, enabled, paused, current, queued: queue.length, loading, error, rate, setRate, read, start, stop, togglePause, source, providers, providerError, native, voices, voice, changeVoice, changeSource };
}

export type SpeechPlayback = ReturnType<typeof useSpeechPlayback>;
export function SpeechControls({ player }: { player: SpeechPlayback }) {
  return <section className="speech-controls" aria-label="发言朗读">
    <audio ref={player.audio} preload="auto" />
    <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
      <b>发言朗读</b>
      <select className="speech-source" aria-label="朗读来源" value={player.source} onChange={(e) => player.changeSource(e.target.value)}>
        {!player.source && <option value="">请选择来源</option>}
        <option value="browser" disabled={!player.native}>浏览器原生{!player.native ? '（当前不可用）' : ''}</option>
        {player.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {player.source === 'browser' && <select className="speech-source" aria-label="浏览器朗读音色" value={player.voice} onChange={(e) => player.changeVoice(e.target.value)}>
        <option value="">系统默认音色</option>
        {player.voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
      </select>}
    </div>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <button className="btn sm primary" disabled={!player.source} onClick={player.enabled ? player.stop : player.start}>{player.enabled ? '关闭自动朗读' : '开启自动朗读'}</button>
      <button className="btn sm" disabled={!player.current} onClick={() => void player.togglePause()}>{player.paused ? '继续播放' : '暂停'}</button>
      <button className="btn sm" disabled={!player.current && !player.queued} onClick={player.stop}>停止</button>
      <label className="row small">语速 <select aria-label="朗读语速" value={player.rate} onChange={(e) => player.setRate(Number(e.target.value))}>
        {[.8, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
      </select></label>
    </div>
    <div className="small muted" role="status" style={{ marginTop: 8 }}>
      {player.current ? `${player.loading ? '正在准备' : player.paused ? '已暂停' : '正在朗读'}：${player.current.seat}号发言${player.queued ? ` · 后续 ${player.queued} 条` : ''}` : player.enabled ? '等待当前视角的新发言，重连不会重读历史。' : '开启后先读最新一条，再按顺序朗读当前视角的新发言；「朗读」可重听单条。'}
    </div>
    {player.source === 'browser' && <div className="tiny muted">原生音色由系统提供；部分浏览器的语速调整在下一条朗读时生效。</div>}
    {player.providerError && <div className="small muted">{player.providerError}</div>}
    {player.error && <div className="error-box small" role="alert">{player.error}</div>}
  </section>;
}
