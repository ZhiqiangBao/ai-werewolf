import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { SpeechControls, type SpeechPlayback } from '../src/components/SpeechPlayback';

afterEach(() => vi.unstubAllGlobals());

function player(patch: Partial<SpeechPlayback> = {}): SpeechPlayback {
  return {
    audio: { current: null }, enabled: true, paused: false, current: { seq: 1, seat: 3, text: '原话' }, queued: 2,
    loading: false, error: '', failed: false, yielding: false, overriding: false,
    rate: 1, setRate: () => {}, read: () => {}, start: () => {}, stop: () => {}, retry: () => {},
    togglePause: async () => {}, source: 'fixture', providers: [{ id: 'fixture', label: 'fixture' }],
    providerError: '', native: false, voices: [], voice: '', changeVoice: () => {}, changeSource: () => {}, ...patch,
  };
}

it.each([
  ['zh-CN', '重试当前发言', '暂停', '等待重试', '轮到你行动，自动朗读已让行。', '正在手动重听，行动倒计时仍在进行。'],
  ['en', 'Retry current speech', 'Pause', 'Waiting for retry', 'Your action is due', 'Manual replay is in progress'],
  ['ja', '現在の発言を再試行', '一時停止', '再試行を待機中', 'あなたの行動の番', '手動再生中も行動の制限時間は進みます。'],
])('%s 保留音频重试、行动让行及手动重听状态，并使用界面语言', (locale, retry, pause, waiting, yielding, manual) => {
  vi.stubGlobal('localStorage', { getItem: () => locale });
  const render = (patch: Partial<SpeechPlayback>) => renderToStaticMarkup(createElement(I18nProvider, null, createElement(SpeechControls, { player: player(patch) })));
  const failed = render({ failed: true });
  expect(failed).toContain(retry);
  expect(failed).toContain(waiting);
  expect(failed).toContain(`<button class="btn sm" disabled="">${pause}</button>`);
  const interrupted = render({ yielding: true });
  expect(interrupted).toContain(yielding);
  expect(interrupted).toContain(`<button class="btn sm" disabled="">${pause}</button>`);
  expect(render({ overriding: true })).toContain(manual);
});
