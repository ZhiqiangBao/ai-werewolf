import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SpeechService, type SpeechProvider } from '../src/speech';
import { speechProvider } from '../src/speech/providers';
import { wavHeader } from '../src/speech/audio';

const directories: string[] = [];
async function directory() { const d = await mkdtemp(join(tmpdir(), 'werewolf-live-speech-')); directories.push(d); return d; }
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const d of directories.splice(0)) {
    if (!resolve(d).startsWith(resolve(tmpdir()) + sep) || !d.includes('werewolf-live-speech-')) throw Error('测试目录越界');
    await rm(d, { recursive: true, force: true });
  }
});
function audio() {
  const header = wavHeader(3, 24000); header.writeUInt32LE(0x7fffffff, 4); header.writeUInt32LE(0x7fffffff, 40);
  return { bytes: Buffer.concat([header, Buffer.from([1, 0, 2, 0, 3, 0])]), mimeType: 'audio/wav' };
}
function provider(synthesize = vi.fn<SpeechProvider['synthesize']>(async () => audio()), id = 'fixture', revision = 1): SpeechProvider {
  return { id, label: id, cacheIdentity: { id, revision }, synthesize };
}

describe('多提供方音频服务', () => {
  it('合并同条并发请求，修正流式 WAV 长度，重启后复用完整缓存', async () => {
    const d = await directory(), p = provider(), service = new SpeechService(d, [p]);
    const [a, b] = await Promise.all([service.render('2号发言。测试。'), service.render('2号发言。测试。')]);
    expect(p.synthesize).toHaveBeenCalledTimes(1); expect(a).toEqual(b);
    expect(a.bytes.readUInt32LE(4)).toBe(a.bytes.length - 8); expect(a.bytes.readUInt32LE(40)).toBe(6);
    expect(a.mimeType).toBe('audio/wav');
    expect(await new SpeechService(d, [p]).render('2号发言。测试。')).toEqual(a);
    expect(p.synthesize).toHaveBeenCalledTimes(1);
  });
  it('提供方与配置版本分别缓存，未知来源失败且不回落到另一家', async () => {
    const d = await directory(), a = provider(), b = provider(undefined, 'other');
    const service = new SpeechService(d, [a, b]);
    await service.render('同文', 'fixture'); await service.render('同文', 'other');
    await expect(service.render('同文', 'unknown')).rejects.toThrow('Unknown');
    const next = provider(undefined, 'fixture', 2); await new SpeechService(d, [next]).render('同文');
    expect(a.synthesize).toHaveBeenCalledTimes(1); expect(b.synthesize).toHaveBeenCalledTimes(1); expect(next.synthesize).toHaveBeenCalledTimes(1);
  });
  it('失败与坏音频不缓存，之后允许重试', async () => {
    const fake = vi.fn<SpeechProvider['synthesize']>().mockRejectedValueOnce(Error('fixture failure'))
      .mockResolvedValueOnce({ bytes: Buffer.from('bad'), mimeType: 'audio/wav' }).mockResolvedValue(audio());
    const service = new SpeechService(await directory(), [provider(fake)]);
    await expect(service.render('发言')).rejects.toThrow('fixture failure');
    await expect(service.render('发言')).rejects.toThrow('Not a WAV');
    expect((await service.render('发言')).bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(fake).toHaveBeenCalledTimes(3);
  });
  it('全局同时最多启动两个不同合成请求，释放后继续排队请求', async () => {
    const release: (() => void)[] = [];
    const fake = vi.fn<SpeechProvider['synthesize']>(() => new Promise((done) => release.push(() => done(audio()))));
    const service = new SpeechService(await directory(), [provider(fake)]);
    const tasks = [service.render('一'), service.render('二'), service.render('三')];
    await vi.waitFor(() => expect(fake).toHaveBeenCalledTimes(2));
    release[0](); await vi.waitFor(() => expect(fake).toHaveBeenCalledTimes(3));
    release[1](); release[2](); await Promise.all(tasks);
  });
});

describe('提供方接入接口', () => {
  it('HTTP 正文映射安全保留原文，认证仅由服务端环境读取，公开目录不泄露配置', async () => {
    vi.stubEnv('FIXTURE_TTS_SECRET', 'fixture-not-a-real-key');
    const send = vi.fn<typeof fetch>(async () => new Response(audio().bytes, { headers: { 'Content-Type': 'audio/wav' } })); vi.stubGlobal('fetch', send);
    const d = await directory(), p = speechProvider({ id: 'other', label: '第三方测试', type: 'http-audio', endpoint: 'https://example.invalid/tts', apiKeyEnv: 'FIXTURE_TTS_SECRET', body: { input: '{{text}}', config: { voice: 'fixture' } } }, d, d);
    const service = new SpeechService(d, [p]); const text = '3号："原文"\n不要改写 $& 和 {{text}}';
    await service.render(text, 'other');
    const request = send.mock.calls[0][1]!;
    expect(JSON.parse(request.body as string)).toEqual({ input: text, config: { voice: 'fixture' } });
    expect(request.headers).toMatchObject({ Authorization: 'Bearer fixture-not-a-real-key' });
    expect(request.redirect).toBe('error');
    expect(service.catalog()).toEqual({ providers: [{ id: 'other', label: '第三方测试' }], defaultProviderId: 'other' });
    expect(JSON.stringify(service.catalog())).not.toMatch(/example|SECRET|fixture-not/);
  });
  it('模块适配器接收文本、配置及取消信号，错误配置不影响游戏服务或触发其他提供方', async () => {
    const d = await directory();
    const source = `export async function synthesize({text,options,signal}) { if(text!=="测试"||options.voice!=="local"||!signal)throw Error("contract"); return {bytes:new Uint8Array([1,2,3]),mimeType:"audio/mpeg"}; }`;
    await writeFile(join(d, 'adapter.mjs'), source);
    const p = speechProvider({ id: 'custom', label: '自定义', type: 'module', module: './adapter.mjs', options: { voice: 'local' } }, d, d);
    expect((await new SpeechService(d, [p]).render('测试')).mimeType).toBe('audio/mpeg');
    const config = join(d, 'speech-providers.json'); await writeFile(config, '{invalid');
    expect(SpeechService.configured(d, config).catalog()).toMatchObject({ providers: [], defaultProviderId: null, error: expect.any(String) });
  });
});
