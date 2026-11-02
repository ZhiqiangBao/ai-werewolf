import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SpeechService } from '../src/speech';
import { defaultSpeechConfig, speechProvider } from '../src/speech/providers';
import { MIMO_MODEL, mimoConnection, mimoRequest, normalizeMimoWav, synthesizeMimo } from '../src/speech/mimo';
import { wavHeader } from '../src/speech/audio';

const directories: string[] = [];
async function directory() { const d = await mkdtemp(join(tmpdir(), 'werewolf-mimo-speech-')); directories.push(d); return d; }
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const d of directories.splice(0)) {
    if (!resolve(d).startsWith(resolve(tmpdir()) + sep) || !d.includes('werewolf-mimo-speech-')) throw Error('测试目录越界');
    await rm(d, { recursive: true, force: true });
  }
});
const profile = { voice: '苏打', label: '测试', rate: 1, instruction: '普通话自然朗读。' };
function wav() { return Buffer.concat([wavHeader(3, 24000), Buffer.from([1, 0, 2, 0, 3, 0])]); }
function reply(bytes = wav(), finish_reason = 'stop') {
  return Response.json({ choices: [{ finish_reason, message: { audio: { data: bytes.toString('base64'), transcript: null } } }] });
}
function tokenPlan() {
  vi.stubEnv('XIAOMI_MIMO_TOKEN_PLAN_URL', 'https://token-plan-cn.xiaomimimo.com/v1');
  vi.stubEnv('XIAOMI_MIMO_TOKEN_PLAN_KEY', 'tp-fixture-secret');
}

describe('小米 MiMo 网页朗读', () => {
  it('使用独立的 Token Plan URL/Key，保留原文及特殊字符，解码 JSON base64，缓存跨重启复用', async () => {
    tokenPlan();
    const send = vi.fn<typeof fetch>(async () => reply()); vi.stubGlobal('fetch', send);
    const d = await directory(), text = '12号："我的原话"\n保留 $& 和 {{text}}。';
    const config = { id: 'mimo', label: '小米 MiMo', type: 'xiaomi-mimo', billing: 'token-plan' } as const;
    const service = new SpeechService(d, [speechProvider(config, d, d)]);
    expect((await service.render(text)).bytes).toEqual(wav());
    expect(send.mock.calls[0][0]).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
    const request = send.mock.calls[0][1]!;
    expect(request.redirect).toBe('error');
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.headers).toMatchObject({ Authorization: 'Bearer tp-fixture-secret' });
    const body = JSON.parse(request.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: expect.any(String) }, { role: 'assistant', content: text }]);
    expect(body.audio).toEqual({ format: 'wav', voice: '苏打' });
    expect(body).toMatchObject({ model: MIMO_MODEL, stream: false });
    expect(body).not.toHaveProperty('word_timestamp_enabled');
    expect(body.audio).not.toHaveProperty('optimize_text_preview');
    await new SpeechService(d, [speechProvider(config, d, d)]).render(text);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(service.catalog())).not.toMatch(/secret|xiaomimimo|API|KEY|URL|billing/);
  });
  it('环境变量仅增加可选来源，保持 Qwen 默认；显式配置仍优先且可以禁用全部服务端来源', async () => {
    vi.stubEnv('XIAOMI_MIMO_API_KEY', ''); vi.stubEnv('XIAOMI_MIMO_TOKEN_PLAN_KEY', ''); vi.stubEnv('XIAOMI_MIMO_TOKEN_PLAN_URL', '');
    expect(defaultSpeechConfig().providers.map((p) => p.id)).toEqual(['qwen-token-plan']);
    tokenPlan();
    vi.stubEnv('XIAOMI_MIMO_API_KEY', 'fixture-api-key');
    const d = await directory();
    expect(SpeechService.configured(d).catalog()).toEqual({ defaultProviderId: 'qwen-token-plan', providers: [
      { id: 'qwen-token-plan', label: 'Token Plan Qwen' }, { id: 'xiaomi-mimo', label: '小米 MiMo' }, { id: 'xiaomi-mimo-token-plan', label: '小米 MiMo Token Plan' },
    ] });
    const file = join(d, 'explicit.json'); await writeFile(file, JSON.stringify({ providers: [] }));
    expect(SpeechService.configured(d, file).catalog().providers).toEqual([]);
  });
  it('模型、音色、端点或计费线路变化不命中旧缓存', async () => {
    tokenPlan(); vi.stubEnv('XIAOMI_MIMO_API_KEY', 'fixture-api-key');
    const send = vi.fn<typeof fetch>(async () => reply()); vi.stubGlobal('fetch', send);
    const d = await directory();
    for (const config of [
      { billing: 'token-plan', voice: '苏打' }, { billing: 'token-plan', voice: '白桦' },
      { billing: 'api', voice: '苏打' }, { billing: 'api', model: 'mimo-v2.5-tts-voicedesign', instruction: '年轻女性，温柔清楚。' },
    ] as const) await new SpeechService(d, [speechProvider({ id: 'mimo', label: '小米', type: 'xiaomi-mimo', ...config }, d, d)]).render('相同原文');
    vi.stubEnv('XIAOMI_MIMO_TOKEN_PLAN_URL', 'https://token-plan-sgp.xiaomimimo.com/v1');
    await new SpeechService(d, [speechProvider({ id: 'mimo', label: '小米', type: 'xiaomi-mimo', billing: 'token-plan' }, d, d)]).render('相同原文');
    expect(send).toHaveBeenCalledTimes(5);
  });
  it('鉴权失败时不切换线路、不回显响应正文、不保存成功缓存，之后可重试', async () => {
    tokenPlan(); vi.stubEnv('XIAOMI_MIMO_API_KEY', 'other-key');
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: 'tp-fixture-secret private text' } }, { status: 401 })).mockImplementation(async () => reply());
    vi.stubGlobal('fetch', send);
    const d = await directory(), service = new SpeechService(d, [speechProvider({ id: 'mimo', label: '小米', type: 'xiaomi-mimo', billing: 'token-plan' }, d, d)]);
    await expect(service.render('原话')).rejects.toThrow(/^MiMo TTS HTTP 401$/);
    await service.render('原话'); expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([url]) => String(url).includes('token-plan-cn'))).toBe(true);
    expect(JSON.stringify(service.catalog())).not.toContain('secret');
  });
  it('缺失套餐凭据、普通 API 的套餐 Key、其他域名和 Anthropic 地址都在发送前拒绝', async () => {
    tokenPlan(); vi.stubEnv('XIAOMI_MIMO_TOKEN_PLAN_KEY', '');
    const send = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', send);
    await expect(synthesizeMimo('测试', profile, MIMO_MODEL, { billing: 'token-plan' })).rejects.toThrow('key is unavailable');
    vi.stubEnv('XIAOMI_MIMO_API_KEY', 'tp-wrong-route');
    await expect(synthesizeMimo('测试', profile)).rejects.toThrow('ordinary API route');
    for (const url of ['http://token-plan-cn.xiaomimimo.com/v1', 'https://example.invalid/v1', 'https://token-plan-cn.xiaomimimo.com/anthropic', 'https://key@token-plan-cn.xiaomimimo.com/v1']) {
      vi.stubEnv('XIAOMI_MIMO_TOKEN_PLAN_URL', url);
      expect(() => mimoConnection({ billing: 'token-plan' })).toThrow();
    }
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['length', 'content_filter'])('拒绝 finish_reason=%s 的不完整语音', async (reason) => {
    tokenPlan(); vi.stubGlobal('fetch', vi.fn(async () => reply(wav(), reason)));
    await expect(synthesizeMimo('原话', profile, MIMO_MODEL, { billing: 'token-plan' })).rejects.toThrow('incomplete');
  });
  it('拒绝错误 JSON、缺失/无效 base64、伪音频及截断 WAV', async () => {
    tokenPlan();
    for (const response of [Response.json({ error: { message: 'private' } }), Response.json({ choices: [{ message: { audio: { data: '***=' } } }] }), reply(Buffer.from('not a WAV')), new Response('{bad', { headers: { 'Content-Type': 'application/json' } })]) {
      vi.stubGlobal('fetch', vi.fn(async () => response));
      await expect(synthesizeMimo('原话', profile, MIMO_MODEL, { billing: 'token-plan' })).rejects.toThrow(/MiMo/);
    }
    expect(() => normalizeMimoWav(wav().subarray(0, 48))).toThrow('Incomplete');
  });
  it('只修正真实 PCM 长度，不改变采样；不接受 Qwen 音色、种子或不支持的参数', () => {
    const bytes = wav(); bytes.writeUInt32LE(0xffffffff, 4); bytes.writeUInt32LE(0xffffffff, 40);
    expect(normalizeMimoWav(bytes)).toEqual(wav());
    expect(() => mimoRequest('测试', { ...profile, voice: 'qwen-audio-3.0-tts-plus-longshuojizhu' })).toThrow('voice');
    expect(() => mimoRequest('测试', { ...profile, seed: 1 })).toThrow('seed');
    expect(() => mimoRequest('测试', { ...profile, rate: 10 })).toThrow('profile');
    expect(mimoRequest('原文', { ...profile, rate: 1.2 }).messages[0].content).toContain('1.2');
    const request = mimoRequest('原文', profile, 'mimo-v2.5-tts-voicedesign');
    expect(request.audio).not.toHaveProperty('voice');
  });
});
