import { useEffect, useRef, useState } from 'react';
import type { GameEvent, Projection } from '@werewolf/protocol';
import { publicSpeech, SpeechCursor, type SpeechItem } from '../speech';

export function useSpeechPlayback(roomId: string, token: string, projection: Projection | null) {
  const [enabled, setEnabled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [current, setCurrent] = useState<SpeechItem | null>(null);
  const [queue, setQueue] = useState<SpeechItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rate, setRate] = useState(1);
  const audio = useRef<HTMLAudioElement | null>(null);
  const cursor = useRef(new SpeechCursor());
  const enabledRef = useRef(false);
  const pausedRef = useRef(false);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const items = publicSpeech(projection?.events ?? []);

  useEffect(() => {
    if (!projection) return;
    const fresh = cursor.current.sync(publicSpeech(projection.events), enabledRef.current);
    if (fresh.length) setQueue((q) => [...q, ...fresh]);
  }, [projection]);

  useEffect(() => {
    if (current || paused || !queue.length) return;
    setCurrent(queue[0]); setQueue((q) => q.slice(1));
  }, [current, paused, queue]);

  useEffect(() => {
    if (!current) return;
    const controller = new AbortController();
    let active = true, objectUrl: string | undefined;
    audio.current ??= new Audio();
    const player = audio.current;
    player.onended = () => { if (active) setCurrent(null); };
    player.onerror = () => {
      if (!active) return;
      setError('音频播放失败，可重听这条发言。'); setLoading(false); setCurrent(null); setQueue([]);
      enabledRef.current = false; setEnabled(false);
    };
    setLoading(true); setError('');
    void (async () => {
      const response = await fetch(`/api/v1/rooms/${roomId}/speech`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventSeq: current.seq }), signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message ?? '朗读暂时不可用，请稍后重试。');
      }
      const blob = await response.blob();
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      player.src = objectUrl; player.playbackRate = rateRef.current;
      setLoading(false);
      if (!pausedRef.current) {
        try { await player.play(); }
        catch { if (active) { pausedRef.current = true; setPaused(true); setError('请点击继续播放以启用声音。'); } }
      }
    })().catch((e: Error) => {
      if (!active) return;
      setLoading(false); setError(e.message); enabledRef.current = false; setEnabled(false); setQueue([]); setCurrent(null);
    });
    return () => {
      active = false; controller.abort(); player.pause(); player.onended = null; player.onerror = null; player.removeAttribute('src');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [current, roomId, token]);

  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate]);
  useEffect(() => () => { audio.current?.pause(); }, []);

  const stop = () => {
    enabledRef.current = false; setEnabled(false); setCurrent(null); setQueue([]); setLoading(false);
    pausedRef.current = false; setPaused(false); audio.current?.pause();
  };
  const read = (event: GameEvent) => {
    const item = publicSpeech([event])[0];
    if (!item) return;
    pausedRef.current = false; setPaused(false); setQueue([]); setCurrent({ ...item });
  };
  const start = () => {
    enabledRef.current = true; setEnabled(true); pausedRef.current = false; setPaused(false); setError('');
    if (!current && items.length) setCurrent({ ...items[items.length - 1] });
    else if (current && audio.current?.src && !loading) void audio.current.play().catch(() => {
      pausedRef.current = true; setPaused(true); setError('请点击继续播放以启用声音。');
    });
  };
  const togglePause = async () => {
    if (!pausedRef.current) { pausedRef.current = true; setPaused(true); audio.current?.pause(); return; }
    pausedRef.current = false; setPaused(false); setError('');
    if (audio.current?.src && !loading) {
      try { await audio.current.play(); } catch { pausedRef.current = true; setPaused(true); setError('浏览器未能播放音频，请再次点击继续。'); }
    }
  };
  return { audio, enabled, paused, current, queued: queue.length, loading, error, rate, setRate, read, start, stop, togglePause };
}

export type SpeechPlayback = ReturnType<typeof useSpeechPlayback>;
export function SpeechControls({ player }: { player: SpeechPlayback }) {
  return <section className="speech-controls" aria-label="发言朗读">
    <audio ref={player.audio} preload="auto" />
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <b>发言朗读</b><span className="tiny muted">Token Plan 语音</span><span className="spacer" />
      <button className="btn sm primary" onClick={player.enabled ? player.stop : player.start}>{player.enabled ? '关闭自动朗读' : '开启自动朗读'}</button>
      <button className="btn sm" disabled={!player.current} onClick={() => void player.togglePause()}>{player.paused ? '继续播放' : '暂停'}</button>
      <button className="btn sm" disabled={!player.current && !player.queued} onClick={player.stop}>停止</button>
      <label className="row small">语速 <select aria-label="朗读语速" value={player.rate} onChange={(e) => player.setRate(Number(e.target.value))}>
        {[.8, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
      </select></label>
    </div>
    <div className="small muted" role="status" style={{ marginTop: 8 }}>
      {player.current ? `${player.loading ? '正在准备' : player.paused ? '已暂停' : '正在朗读'}：${player.current.seat}号发言${player.queued ? ` · 后续 ${player.queued} 条` : ''}` : player.enabled ? '等待新的公开发言，重连不会重读历史。' : '开启后先读最新一条，再按顺序朗读新发言；记录中的「朗读」可重听单条。'}
    </div>
    {player.error && <div className="error-box small" role="alert">{player.error}</div>}
  </section>;
}
