import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserSpeechOutput, serverSpeechOutput, type SpeechOutputEvents } from '../src/speech-output';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const item = { seq: 3, seat: 2, text: '原文。' };
const events = (): SpeechOutputEvents => ({ ready: vi.fn(), ended: vi.fn(), blocked: vi.fn(), failed: vi.fn() });
describe('统一播放接口', () => {
  it('原生来源只调用系统朗读，保留号码原文，支持音色、暂停、继续与取消后忽略旧事件', async () => {
    const send = vi.fn(); vi.stubGlobal('fetch', send);
    const voice = { voiceURI: 'fixture-cn', lang: 'zh-CN' } as SpeechSynthesisVoice;
    const native = { speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [voice] };
    const u = {} as SpeechSynthesisUtterance, e = events();
    const driver = browserSpeechOutput(native as unknown as SpeechSynthesis, () => u, voice.voiceURI);
    await driver.play(item, 1.25, e);
    expect(u.text).toBe('2号发言。原文。'); expect(u.voice).toBe(voice); expect(u.rate).toBe(1.25);
    u.onstart!.call(u, {} as SpeechSynthesisEvent); expect(e.ready).toHaveBeenCalledOnce();
    driver.pause(); await driver.resume(); expect(native.pause).toHaveBeenCalledOnce(); expect(native.resume).toHaveBeenCalledOnce();
    driver.stop(); u.onend!.call(u, {} as SpeechSynthesisEvent);
    expect(e.ended).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('服务端来源只发送事件号与来源标识，准备期间暂停有效，停止后清理音频资源', async () => {
    let complete!: (response: Response) => void;
    const send = vi.fn<typeof fetch>(() => new Promise((resolve) => { complete = resolve; })); vi.stubGlobal('fetch', send);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const audio = { src: '', playbackRate: 1, pause: vi.fn(), play: vi.fn(async () => {}), removeAttribute: vi.fn(), onended: null, onerror: null };
    const driver = serverSpeechOutput(audio as unknown as HTMLAudioElement, 'room', 'fixture-token', 'third-party'), e = events();
    const pending = driver.play(item, 1, e); driver.pause();
    complete(new Response(new Blob(['audio'], { type: 'audio/mpeg' }))); await pending;
    expect(JSON.parse(send.mock.calls[0][1]!.body as string)).toEqual({ eventSeq: 3, providerId: 'third-party' });
    expect(audio.play).not.toHaveBeenCalled(); expect(e.ready).toHaveBeenCalledOnce();
    await driver.resume(); expect(audio.play).toHaveBeenCalledOnce();
    driver.setRate(1.5); expect(audio.playbackRate).toBe(1.5);
    driver.stop(); expect(audio.removeAttribute).toHaveBeenCalledWith('src'); expect(revoke).toHaveBeenCalledOnce();
  });
  it('停止或切换来源后，迟到的音频不会开始播放', async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { complete = resolve; })));
    const audio = { src: '', pause: vi.fn(), play: vi.fn(), removeAttribute: vi.fn() };
    const driver = serverSpeechOutput(audio as unknown as HTMLAudioElement, 'room', 'token', 'source'), e = events();
    const pending = driver.play(item, 1, e); driver.stop(); complete(new Response('late')); await pending;
    expect(audio.play).not.toHaveBeenCalled(); expect(e.ready).not.toHaveBeenCalled(); expect(e.failed).not.toHaveBeenCalled();
  });
});
