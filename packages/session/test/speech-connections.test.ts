import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SpeechConnections } from '../src/speech/connections';
import { SecretBox } from '../src/secret';
import { SpeechService } from '../src/speech';
import { wavHeader } from '../src/speech/audio';

const directories: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'werewolf-speech-connections-')); directories.push(dir);
  const file = join(dir, 'connections.json'), secrets = SecretBox.ephemeral();
  return { dir, file, secrets, library: new SpeechConnections(file, secrets, dir) };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes('werewolf-speech-connections-')) throw Error('测试目录越界');
    await rm(dir, { recursive: true, force: true });
  }
});
const draft = { name: '自选朗读', url: 'https://fixture.invalid/v1/audio/speech', apiKey: 'fixture-private-key', kind: 'speech-compatible', model: 'fixture-model', voice: 'fixture-voice' };
const wav = () => Buffer.concat([wavHeader(3, 24000), Buffer.from([1, 0, 2, 0, 3, 0])]);

describe('网页配置的房间 TTS 来源', () => {
  it('首页共享库跨房间复用，兼容 v1 私有配置，并仅在显式分享后扩大旧来源的范围', async () => {
    const { dir, file, secrets, library } = await fixture();
    const legacy = library.save('a', draft);
    const existing = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ version: 1, rooms: existing.rooms }));
    const upgraded = new SpeechConnections(file, secrets, dir);
    expect(upgraded.views('a')).toEqual([legacy]); expect(upgraded.sharedViews()).toEqual([]);
    const shared = upgraded.saveShared({ ...draft, name: '首页语音' });
    expect(upgraded.views('b')).toEqual([]);
    expect(upgraded.sharedViews()).toEqual([shared]);
    expect(() => upgraded.share('b', legacy.id)).toThrow('没有');
    expect(upgraded.share('a', legacy.id)).toMatchObject({ id: legacy.id, hasKey: true });
    expect(upgraded.views('a')).toEqual([]);
    const restored = new SpeechConnections(file, secrets, dir);
    expect(restored.sharedViews().map((item) => item.id)).toEqual([shared.id, legacy.id]);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2);
    expect(await readFile(file, 'utf8')).not.toContain(draft.apiKey);
    const service = new SpeechService(dir, []);
    for (const room of ['a', 'b']) expect(service.catalog([...restored.sharedProviders(), ...restored.providers(room)]).providers).toHaveLength(2);
    restored.removeShared(shared.id); expect(restored.sharedViews()).toHaveLength(1);
  });
  it('加密保存、重启后加载、留空保留 Key；修改请求参数失效缓存，不共享其他房间的来源', async () => {
    const { dir, file, secrets, library } = await fixture();
    const saved = library.save('a', draft);
    expect(JSON.stringify(saved)).not.toContain(draft.apiKey);
    expect(await readFile(file, 'utf8')).not.toContain(draft.apiKey);
    expect(library.views('b')).toEqual([]);
    const restarted = new SpeechConnections(file, secrets, dir);
    expect(restarted.views('a')).toEqual([saved]);
    const send = vi.fn<typeof fetch>(async () => new Response(wav(), { headers: { 'Content-Type': 'application/octet-stream' } })); vi.stubGlobal('fetch', send);
    const service = new SpeechService(dir, []);
    await service.render('12号："原话" $& {{text}}', saved.id, restarted.providers('a'));
    expect(send.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-private-key' });
    expect(JSON.parse(send.mock.calls[0][1]?.body as string)).toEqual({ input: '12号："原话" $& {{text}}', model: 'fixture-model', voice: 'fixture-voice', response_format: 'wav' });
    restarted.save('a', { ...draft, apiKey: '', model: 'changed' }, saved.id);
    await service.render('12号："原话" $& {{text}}', saved.id, restarted.providers('a'));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-private-key' });
    await expect(service.render('原文', saved.id, restarted.providers('b'))).rejects.toThrow('Unknown');
    expect(() => restarted.save('b', draft, saved.id)).toThrow('没有');
    restarted.remove('a', saved.id);
    await expect(service.render('原文', saved.id, restarted.providers('a'))).rejects.toThrow('Unknown');
  });
  it('JSON Base64 和 Hex 协议按模板处理，小米要求完整结束，MiniMax 检查业务状态', async () => {
    const { dir, library } = await fixture();
    const mimo = library.save('a', { ...draft, kind: 'mimo', model: 'mimo-v2.5-tts', voice: '苏打' });
    const mini = library.save('a', { ...draft, kind: 'minimax' });
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: 'stop', message: { audio: { data: wav().toString('base64') } } }] }))
      .mockResolvedValueOnce(Response.json({ data: { audio: 'fffb1020', status: 2 }, base_resp: { status_code: 0 } }))
      .mockResolvedValueOnce(Response.json({ data: { audio: 'fffb1020' }, base_resp: { status_code: 1000 } }));
    vi.stubGlobal('fetch', send);
    const service = new SpeechService(dir, []);
    expect((await service.render('测试', mimo.id, library.providers('a'))).bytes).toEqual(wav());
    expect(JSON.parse(send.mock.calls[0][1]?.body as string).messages[1]).toEqual({ role: 'assistant', content: '测试' });
    expect((await service.render('测试', mini.id, library.providers('a'))).bytes).toEqual(Buffer.from('fffb1020', 'hex'));
    await expect(service.render('另一句', mini.id, library.providers('a'))).rejects.toThrow('did not complete');
    send.mockResolvedValueOnce(Response.json({ data: { audio: 'fffb1020', status: 1 }, base_resp: { status_code: 0 } }));
    await expect(service.render('半截音频', mini.id, library.providers('a'))).rejects.toThrow('incomplete audio');
  });
  it('自定义 JSON 字段、请求头及空前缀有效；不允许 JS、文件地址、URL 密钥或缺少原文的模板', async () => {
    const { dir, library } = await fixture();
    const custom = { ...draft, kind: 'http-json-audio', bodyJson: '{"nested":{"say":"{{text}}"}}', apiKeyHeader: 'X-Api-Key', apiKeyPrefix: '', audioPath: 'output.0.bytes', encoding: 'base64', mimeType: 'audio/wav' };
    const saved = library.save('a', custom);
    const send = vi.fn<typeof fetch>(async () => Response.json({ output: [{ bytes: wav().toString('base64') }] })); vi.stubGlobal('fetch', send);
    await new SpeechService(dir, []).render('原话', saved.id, library.providers('a'));
    expect(send.mock.calls[0][1]?.headers).toMatchObject({ 'X-Api-Key': 'fixture-private-key' });
    expect(JSON.parse(send.mock.calls[0][1]?.body as string)).toEqual({ nested: { say: '原话' } });
    for (const invalid of [{ url: 'file:///secret' }, { url: 'https://key:secret@fixture.invalid' }, { url: 'https://fixture.invalid?key=secret' }, { kind: 'module' }, { bodyJson: '{"text":"hardcoded"}' }, { audioPath: 'output[0].bytes' }, { apiKeyHeader: 'Host' }, { apiKeyPrefix: 'bad\r\nheader' }]) {
      expect(() => library.save('a', { ...custom, ...invalid })).toThrow();
    }
  });
  it('原有提供方与播放接口可并存；公开目录只包含来源名称', async () => {
    const { dir, library } = await fixture(); const saved = library.save('a', draft);
    const service = new SpeechService(dir, [{ id: 'legacy', label: '原来源', cacheIdentity: {}, synthesize: async () => ({ bytes: wav(), mimeType: 'audio/wav' }) }]);
    expect(service.catalog(library.providers('a'))).toEqual({ defaultProviderId: 'legacy', providers: [{ id: 'legacy', label: '原来源' }, { id: saved.id, label: draft.name }] });
    expect((await service.render('原话')).mimeType).toBe('audio/wav');
  });
  it('Qwen 网页配置使用显式地址和密钥，不读取其他线路，保留旧入口兼容', async () => {
    const { dir, library } = await fixture();
    const saved = library.save('a', { ...draft, kind: 'qwen' });
    const bytes = Buffer.concat([wavHeader(1000, 24000), Buffer.alloc(2000)]);
    const send = vi.fn<typeof fetch>(async () => new Response(`data: ${JSON.stringify({ output: { finish_reason: 'stop', audio: { data: bytes.toString('base64') } } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', send);
    const audio = await new SpeechService(dir, []).render('原文', saved.id, library.providers('a'));
    expect(audio.bytes).toEqual(bytes);
    expect(send.mock.calls[0][0]).toBe(draft.url);
    expect(send.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer fixture-private-key', 'X-DashScope-SSE': 'enable' } });
    expect(JSON.parse(send.mock.calls[0][1]?.body as string).input.text).toBe('原文');
  });
  it('配置损坏时保留原文件并报告，主密钥丢失时不把密文当作 Key', async () => {
    const { dir, file, library } = await fixture(); const saved = library.save('a', draft);
    expect(new SpeechConnections(file, SecretBox.ephemeral(), dir).views('a')[0]).toMatchObject({ id: saved.id, hasKey: false });
    await writeFile(file, '{broken'); const broken = new SpeechConnections(file, SecretBox.ephemeral(), dir);
    expect(broken.error).toBeTruthy(); expect(broken.providers('a')).toEqual([]);
    expect(() => broken.save('a', draft)).toThrow('原文件未被覆盖'); expect(await readFile(file, 'utf8')).toBe('{broken');
  });
});
