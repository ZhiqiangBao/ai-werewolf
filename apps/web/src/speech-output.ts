import { gameLanguage, gameText } from '@werewolf/protocol';
import type { SpeechItem } from './speech';

export interface SpeechOutputEvents { ready(): void; ended(): void; blocked(message: string): void; failed(message: string): void }
/** 浏览器原生与服务端音频共用播放生命周期；来源切换无需改动事件队列。 */
export interface SpeechOutput {
  play(item: SpeechItem, rate: number, events: SpeechOutputEvents): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  setRate(rate: number): void;
  stop(): void;
}
export function browserSpeechOutput(synthesis: SpeechSynthesis, utterance: () => SpeechSynthesisUtterance, voiceURI: string): SpeechOutput {
  let current: SpeechSynthesisUtterance | null = null, generation = 0, timeout: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timeout); timeout = undefined; };
  const stop = () => { generation++; clear(); current = null; synthesis.cancel(); };
  return {
    async play(item, rate, events) {
      stop(); const own = generation; const u = utterance(); current = u;
      if (synthesis.paused) synthesis.resume();
      u.text = gameText(item.locale, '{0}号发言。{1}', item.seat, item.text); u.rate = rate;
      const language = gameLanguage(item.locale);
      const voices = synthesis.getVoices();
      const voice = voices.find((v) => v.voiceURI === voiceURI) ?? voices.find((v) => v.lang === language.speechLang) ?? voices.find((v) => v.lang.split('-')[0] === language.speechLang.split('-')[0]);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? language.speechLang;
      u.onstart = () => { clear(); if (own === generation) events.ready(); };
      u.onend = () => { clear(); if (own === generation) events.ended(); };
      u.onerror = (e) => { clear(); if (own === generation) events.failed(`浏览器原生朗读失败（${e.error}），请检查系统音色或选择其他来源。`); };
      timeout = setTimeout(() => { if (own === generation) events.failed('浏览器没有启动原生朗读，请检查系统音色或选择其他来源。'); }, 10000);
      synthesis.speak(u);
    },
    pause() { clear(); synthesis.pause(); },
    async resume() { synthesis.resume(); },
    setRate(rate) { if (current) current.rate = rate; },
    stop,
  };
}
export function serverSpeechOutput(audio: HTMLAudioElement, roomId: string, token: string, providerId: string): SpeechOutput {
  let controller: AbortController | undefined, url: string | undefined, generation = 0, rate = 1, paused = false;
  const stop = () => {
    generation++; paused = false; controller?.abort(); controller = undefined;
    audio.onended = null; audio.onerror = null; audio.pause(); audio.removeAttribute('src');
    if (url) URL.revokeObjectURL(url); url = undefined;
  };
  return {
    async play(item, speed, events) {
      stop(); const own = generation; rate = speed; controller = new AbortController();
      try {
        const response = await fetch(`/api/v1/rooms/${roomId}/speech`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventSeq: item.seq, providerId }), signal: controller.signal,
        });
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw Error(body.message ?? '朗读来源暂时不可用。'); }
        const blob = await response.blob(); if (own !== generation) return;
        url = URL.createObjectURL(blob); audio.src = url; audio.playbackRate = rate;
        audio.onended = () => { if (own === generation) events.ended(); };
        audio.onerror = () => { if (own === generation) events.failed('音频播放失败，可重听该条或选择其他来源。'); };
        events.ready();
        if (!paused) try { await audio.play(); } catch { if (own === generation) events.blocked('请点击继续播放以启用声音。'); }
      } catch (e) { if (own === generation) events.failed((e as Error).message); }
    },
    pause() { paused = true; audio.pause(); },
    async resume() { paused = false; if (audio.src) await audio.play(); },
    setRate(value) { rate = value; audio.playbackRate = value; },
    stop,
  };
}
