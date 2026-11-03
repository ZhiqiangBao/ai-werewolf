import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameEvent, Projection, RoomBrief, SpeechProviderView, ViewResponse } from '@werewolf/protocol';
import { api } from '../api';
import { audibleSpeech } from '../speech';
import { browserSpeechOutput, serverSpeechOutput } from '../speech-output';
import { humanDecisionWindow, SpeechPlaybackController, type PlaybackState } from '../speech-playback';

export function useSpeechPlayback(roomId: string, token: string, projection: Projection | null, room?: RoomBrief, presentation?: ViewResponse['presentation']) {
  const [snapshot, setSnapshot] = useState<{ player: SpeechPlaybackController; state: PlaybackState } | null>(null);
  const [rate, setRate] = useState(1);
  const [providers, setProviders] = useState<SpeechProviderView[]>([]), [providerError, setProviderError] = useState('');
  const [source, setSource] = useState(''), [voice, setVoice] = useState(''), [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const native = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
  const audio = useRef<HTMLAudioElement | null>(null);
  // 凭证或视角改变时创建独立的游标和队列，旧控制器在 effect 清理阶段停止。
  const currentPlayer = useRef<SpeechPlaybackController | null>(null);
  const player = useMemo(() => {
    const own: SpeechPlaybackController = new SpeechPlaybackController((state) => {
      if (currentPlayer.current === own) setSnapshot({ player: own, state });
    });
    return own;
  }, [roomId, token, room?.viewer, room?.seat]);
  currentPlayer.current = player;
  const state = snapshot?.player === player ? snapshot.state : player.snapshot();
  const sourceRef = useRef(source); sourceRef.current = source;
  const items = audibleSpeech(projection?.events ?? [], projection?.locale);
  const decision = humanDecisionWindow(room, projection, presentation);

  useEffect(() => {
    if (!native) return;
    const refresh = () => setVoices(window.speechSynthesis.getVoices());
    refresh(); window.speechSynthesis.addEventListener('voiceschanged', refresh);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh);
  }, [native]);
  useEffect(() => {
    let active = true, request = 0;
    const refresh = (initial = false) => {
      const own = ++request;
      void api.speechProviders(roomId, token).then((data) => {
        if (!active || own !== request) return;
        setProviders(data.providers); setProviderError(data.error ?? '');
        if (!initial && sourceRef.current) {
          if (sourceRef.current !== 'browser' && !data.providers.some((p) => p.id === sourceRef.current)) {
            player.setSource(null, '所选朗读来源已删除，请重新选择。'); setSource('');
          }
          return;
        }
        const preferred = localStorage.getItem('werewolf-speech-source');
        setSource(preferred === 'browser' && native ? 'browser' : data.providers.some((p) => p.id === preferred) ? preferred! : native ? 'browser' : data.defaultProviderId ?? '');
      }, () => { if (active && own === request) { setProviderError('无法载入服务端朗读来源。'); if (initial && native) setSource('browser'); } });
    };
    const changed = (event: Event) => { if (['*', roomId].includes((event as CustomEvent).detail)) refresh(); };
    const focus = () => refresh();
    refresh(true);
    window.addEventListener('werewolf-speech-providers-updated', changed); window.addEventListener('focus', focus);
    return () => { active = false; window.removeEventListener('werewolf-speech-providers-updated', changed); window.removeEventListener('focus', focus); };
  }, [roomId, token, native, player]);
  useEffect(() => { player.setDecision(decision); }, [decision?.id, decision?.availableAt, player]);
  useEffect(() => {
    if (!source) return;
    player.setSource(() => {
      audio.current ??= new Audio();
      return source === 'browser'
        ? browserSpeechOutput(window.speechSynthesis, () => new SpeechSynthesisUtterance(), voice)
        : serverSpeechOutput(audio.current, roomId, token, source);
    });
  }, [source, voice, roomId, token, player]);
  useEffect(() => { if (projection) player.sync(audibleSpeech(projection.events, projection.locale)); }, [projection, player]);
  useEffect(() => { player.setRate(rate); }, [rate, player]);
  useEffect(() => () => player.dispose(), [player]);

  const read = (event: GameEvent) => { const item = audibleSpeech([event], projection?.locale)[0]; if (item) player.read(item); };
  const changeSource = (value: string) => { if (!value) player.setSource(null); setSource(value); localStorage.setItem('werewolf-speech-source', value); };
  return { audio, ...state, rate, setRate, read, start: () => player.start(items), stop: () => player.stop(),
    retry: () => player.retry(), togglePause: () => player.togglePause(), source, providers, providerError, native, voices, voice, changeVoice: setVoice, changeSource };
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
        {player.voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang}</option>)}
      </select>}
    </div>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <button className="btn sm primary" disabled={!player.source && !player.enabled} onClick={player.enabled ? player.stop : player.start}>{player.enabled ? '关闭自动朗读并清空队列' : '开启自动朗读'}</button>
      <button className="btn sm" disabled={(!player.current && !player.queued && !player.paused) || player.failed || player.yielding} onClick={() => void player.togglePause()}>{player.paused ? '继续播放' : '暂停'}</button>
      {player.failed && <button className="btn sm primary" disabled={!player.source || player.yielding} onClick={player.retry}>重试当前发言</button>}
      <button className="btn sm" disabled={!player.current && !player.queued} onClick={player.stop}>停止并清空队列</button>
      <label className="row small">语速 <select aria-label="朗读语速" value={player.rate} onChange={(e) => player.setRate(Number(e.target.value))}>
        {[.8, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
      </select></label>
    </div>
    <div className="small muted" role="status" style={{ marginTop: 8 }}>
      {player.yielding ? '轮到你行动，自动朗读已让行。手动重听会继续播放，行动倒计时仍在进行。' : player.current ? `${player.failed ? '等待重试' : player.loading ? '正在准备' : player.paused ? '已暂停' : '正在朗读'}：${player.current.seat}号发言${player.queued ? ` · 后续 ${player.queued} 条` : ''}` : player.paused ? `自动朗读已暂停${player.queued ? ` · 待播 ${player.queued} 条` : ''}。` : player.enabled ? '等待当前视角的新发言，重连不会重读历史。' : '开启后先读最新一条，再按顺序朗读当前视角的新发言；「朗读」可重听单条。'}
    </div>
    {player.overriding && <div className="small muted">正在手动重听，行动倒计时仍在进行。</div>}
    {player.source === 'browser' && <div className="tiny muted">原生音色由系统提供；部分浏览器的语速调整在下一条朗读时生效。</div>}
    {player.providerError && <div className="small muted">{player.providerError}</div>}
    {player.error && <div className="error-box small" role="alert">{player.error}</div>}
  </section>;
}
