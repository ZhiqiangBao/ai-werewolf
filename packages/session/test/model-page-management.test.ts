import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createHttpServer, isLocalManagementRequest } from '../../../apps/server/src/http-server';
import { MemoryStore, RoomManager, SecretBox, SpeechConnections, SpeechService } from '../src/index';
import { ModelLibrary } from '../src/model-library';
import { projectQwenTokenPlanKey } from '../src/project-models';

it('编辑模型保留房间快照，删除拒绝仍被房间使用的模型', () => {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-model-page-'));
  const file = join(dir, 'models.json');
  const secrets = SecretBox.ephemeral();
  const store = new MemoryStore();
  const manager = new RoomManager({ store, secrets, modelsPath: file, tickMs: 0 });
  try {
    const model = manager.addModel({ name: 'wrong-name', baseUrl: 'https://example.com/v1', apiKey: 'secret-value' });
    const updated = manager.updateModel(model.id, { name: 'correct-name', baseUrl: 'https://example.com/v1', apiKey: '', apiProtocol: 'chat_completions' });
    expect(updated).toMatchObject({ id: model.id, label: 'correct-name', hasKey: true });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(secrets.decrypt(saved.models[0].apiKeyEnc)).toBe('secret-value');
    expect(JSON.stringify(updated)).not.toContain('secret-value');
    const room = manager.createRoom();
    manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, presetId: model.id }] });
    expect(() => manager.deleteModel(model.id)).toThrow(new RegExp(room.roomId));
    const before = manager.getSetup(room.roomId, room.hostToken).seats[0];
    manager.updateModel(model.id, { name: 'another', baseUrl: 'https://other.example/v1', apiKey: 'new-secret', apiProtocol: 'responses' });
    expect(manager.getSetup(room.roomId, room.hostToken).seats[0]).toEqual(before);
    expect(() => manager.deleteModel(model.id)).toThrow(new RegExp(room.roomId));
    manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, modelId: null, model: 'different' }] });
    manager.deleteModel(model.id);
    expect(manager.modelPresets()).toEqual([]);
    const archived = JSON.parse(readFileSync(file, 'utf8')).models[0];
    expect(archived.lifecycle).toBe('archived');
    expect(secrets.decrypt(archived.apiKeyEnc)).toBe('new-secret');
    expect(manager.addModel({ name: 'correct-name', baseUrl: 'https://example.com/v1', apiKey: 'new-key' }).id).not.toBe(model.id);
  } finally {
    manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('删除忽略真人或模拟座位的遗留模型字段，只列出实际使用的房间', () => {
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
  try {
    const model = manager.addModel({ name: 'fixture', baseUrl: 'https://example.com/v1', apiKey: 'key' });
    const human = manager.createRoom(), mock = manager.createRoom(), active = manager.createRoom();
    manager.updateSetup(human.roomId, human.hostToken, { seats: [{ seat: 1, presetId: model.id }] });
    manager.updateSetup(human.roomId, human.hostToken, { seats: [{ seat: 1, controller: 'human' }] });
    manager.updateSetup(mock.roomId, mock.hostToken, { seats: [{ seat: 1, presetId: model.id }] });
    manager.updateSetup(mock.roomId, mock.hostToken, { seats: [{ seat: 1, adapter: 'mock' }] });
    manager.updateSetup(active.roomId, active.hostToken, { seats: [{ seat: 1, presetId: model.id }] });
    try { manager.deleteModel(model.id); throw Error('预期删除被拒绝'); } catch (error) {
      expect((error as Error).message).toContain(active.roomId);
      expect((error as Error).message).not.toContain(human.roomId);
      expect((error as Error).message).not.toContain(mock.roomId);
    }
    manager.updateSetup(active.roomId, active.hostToken, { seats: [{ seat: 1, adapter: 'mock' }] });
    expect(() => manager.deleteModel(model.id)).not.toThrow();
    for (const room of [human, mock, active]) expect(manager.getSetup(room.roomId, room.hostToken).validationErrors.join(' ')).not.toContain('模型已停用或不存在');
  } finally { manager.dispose(); }
});

it('归并别名的房间引用阻止删除；归档后保留别名并可重载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-model-page-'));
  const file = join(dir, 'models.json');
  const secrets = SecretBox.ephemeral();
  const library = new ModelLibrary(secrets, file);
  const target = library.add('same', 'https://example.com/v1', 'key');
  // 构造一条兼容旧数据的同模型别名。
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.models.push({ ...raw.models[0], id: 'old-alias', mergedInto: target.id, mergeEvidence: { kind: 'identical_model' } });
  writeFileSync(file, JSON.stringify(raw));
  const manager = new RoomManager({ store: new MemoryStore(), secrets, modelsPath: file, tickMs: 0 });
  try {
    expect(() => manager.updateModel(target.id, { name: 'new', baseUrl: 'https://example.com/v1' })).toThrow(/归并/);
    const room = manager.createRoom();
    // 没有 modelId 的旧座位也要按模型与路由匹配。
    manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, adapter: 'openai_compatible', model: 'same', baseUrl: 'https://example.com/v1' }] });
    expect(() => manager.deleteModel(target.id)).toThrow(/未结束的房间/);
    manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, model: 'other' }] });
    manager.deleteModel(target.id);
    expect(new ModelLibrary(secrets, file).find('old-alias')?.lifecycle).toBe('archived');
    expect(manager.addModel({ name: 'same', baseUrl: 'https://example.com/v1', apiKey: 'new-key' }).id).not.toBe(target.id);
  } finally {
    manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('模型编辑和删除只接受本机同源请求', () => {
  const check = (remoteAddress: string, host: string, origin?: string) => isLocalManagementRequest({ headers: { host, origin }, socket: { remoteAddress } } as Parameters<typeof isLocalManagementRequest>[0]);
  expect(check('127.0.0.1', '127.0.0.1:3000', 'http://127.0.0.1:3000')).toBe(true);
  expect(check('::ffff:127.0.0.1', '127.0.0.1:3000', 'http://127.0.0.1:3000')).toBe(true);
  expect(check('::1', '[::1]:3000', 'http://[::1]:3000')).toBe(false);
  expect(check('127.0.0.1', 'localhost:3000', 'http://localhost:3000')).toBe(false);
  expect(check('127.0.0.1', '127.1:3000', 'http://127.1:3000')).toBe(false);
  expect(check('192.168.1.2', '127.0.0.1:3000', 'http://127.0.0.1:3000')).toBe(false);
  expect(check('127.0.0.1', 'attacker.example:3000', 'http://attacker.example:3000')).toBe(false);
  expect(check('127.0.0.1', '127.0.0.1:3000', 'http://attacker.example')).toBe(false);
  expect(check('127.0.0.1', '127.0.0.1:3000', 'http://127.0.0.1:4000')).toBe(false);
});

it('环境变量密钥只保存变量名，动态读取并可显式切换来源', () => {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-model-page-'));
  const file = join(dir, 'models.json');
  const name = `WEREWOLF_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  const secrets = SecretBox.ephemeral();
  const manager = new RoomManager({ store: new MemoryStore(), secrets, modelsPath: file, tickMs: 0 });
  const input = { name: 'env-model', baseUrl: 'https://example.com/v1', apiProtocol: 'chat_completions' };
  try {
    expect(() => manager.addModel({ ...input, apiKeyEnv: '${BAD}' })).toThrow(/环境变量名称无效/);
    expect(() => manager.addModel({ ...input, apiKeyEnv: name })).toThrow(/项目配置/);
    writeFileSync(join(dir, 'model-key-envs.json'), JSON.stringify({ variables: [name] }));
    expect(() => manager.addModel({ ...input, apiKeyEnv: name, apiKey: 'other' })).toThrow(/只能选择一种/);
    const model = manager.addModel({ ...input, apiKeyEnv: name });
    expect(model).toMatchObject({ apiKeyEnv: name, hasKey: false });
    const room = manager.createRoom();
    expect(() => manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, presetId: model.id }] })).toThrow(/环境变量未设置/);
    process.env[name] = 'test-value-one';
    expect(manager.modelPresets()[0]).toMatchObject({ apiKeyEnv: name, hasKey: true });
    expect(new ModelLibrary(secrets, file).find(model.id)?.apiKey).toBe('test-value-one');
    process.env[name] = 'test-value-two';
    expect(new ModelLibrary(secrets, file).find(model.id)?.apiKey).toBe('test-value-two');
    expect(readFileSync(file, 'utf8')).not.toContain('test-value');
    writeFileSync(join(dir, 'model-key-envs.json'), JSON.stringify({ variables: [] }));
    expect(manager.updateModel(model.id, { ...input, apiKey: '', apiKeyEnv: '' })).toMatchObject({ apiKeyEnv: name, hasKey: true });
    expect(manager.updateModel(model.id, { ...input, apiKeyEnv: name })).toMatchObject({ apiKeyEnv: name, hasKey: true });
    manager.updateModel(model.id, { ...input, apiKey: 'new-secret' });
    expect(manager.modelPresets()[0]).not.toHaveProperty('apiKeyEnv');
    const saved = JSON.parse(readFileSync(file, 'utf8')).models[0];
    expect(saved).not.toHaveProperty('apiKeyEnv');
    expect(secrets.decrypt(saved.apiKeyEnc)).toBe('new-secret');
    expect(() => manager.updateModel(model.id, { ...input, apiKeyEnv: name })).toThrow(/项目配置/);
    writeFileSync(join(dir, 'model-key-envs.json'), JSON.stringify({ variables: [name] }));
    manager.updateModel(model.id, { ...input, apiKeyEnv: name });
    expect(JSON.parse(readFileSync(file, 'utf8')).models[0]).toMatchObject({ apiKeyEnc: null, apiKeyEnv: name });
  } finally {
    delete process.env[name];
    manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('Qwen 项目回退可从模型环境变量读取且不需要创建主密钥', () => {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-model-page-'));
  const name = `WEREWOLF_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  const previousData = process.env.WEREWOLF_DATA;
  try {
    process.env.WEREWOLF_DATA = dir;
    process.env[name] = 'sk-sp-fixture';
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 2, models: [{ baseUrl: 'https://token-plan.maas.qianwenaiapi.com', apiKeyEnc: null, apiKeyEnv: name }] }));
    expect(projectQwenTokenPlanKey()).toBe('sk-sp-fixture');
    process.env[name] = 'sk-sp-changed';
    expect(projectQwenTokenPlanKey()).toBe('sk-sp-changed');
  } finally {
    if (previousData === undefined) delete process.env.WEREWOLF_DATA; else process.env.WEREWOLF_DATA = previousData;
    delete process.env[name];
    rmSync(dir, { recursive: true, force: true });
  }
});

it('席位保留选中模型时的加密快照，模型编辑和变量变化不修改既有房间', () => {
  const name = `WEREWOLF_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-model-page-'));
  writeFileSync(join(dir, 'model-key-envs.json'), JSON.stringify({ variables: [name] }));
  const store = new MemoryStore(), secrets = SecretBox.ephemeral();
  const manager = new RoomManager({ store, secrets, modelsPath: join(dir, 'models.json'), tickMs: 0 });
  try {
    process.env[name] = 'snapshot-secret';
    const model = manager.addModel({ name: 'example', baseUrl: 'https://example.com/v1', apiKeyEnv: name });
    const room = manager.createRoom();
    manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, presetId: model.id }] });
    process.env[name] = 'later-secret';
    manager.updateModel(model.id, { name: 'changed', baseUrl: 'https://other.example/v1', apiKey: 'replacement-secret', apiProtocol: 'responses' });
    manager.dispose();
    const seat = store.rooms.get(room.roomId)!.seats[0];
    expect(secrets.decrypt(seat.apiKeyEnc!)).toBe('snapshot-secret');
    expect(seat).toMatchObject({ model: 'example', baseUrl: 'https://example.com/v1', apiProtocol: 'chat_completions' });
    expect(JSON.stringify(manager.modelPresets())).not.toContain('later-secret');
  } finally {
    delete process.env[name];
    manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('模型与共享语音库限制本机同源管理，房间来源仍按凭证使用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-model-page-'));
  const secrets = SecretBox.ephemeral();
  const manager = new RoomManager({ store: new MemoryStore(), secrets, modelsPath: join(dir, 'models.json'), tickMs: 0 });
  const speech = new SpeechService(dir, []);
  const speechConnections = new SpeechConnections(join(dir, 'speech.json'), secrets, dir);
  const render = vi.spyOn(speech, 'render').mockRejectedValue(new Error('fixture provider unavailable'));
  const http = createHttpServer({ manager, webRoot: dir, speech, speechConnections });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\werewolf-model-${randomUUID()}` : join(dir, 'http.sock');
  let remoteAddress = '127.0.0.1';
  // 沙箱禁止 TCP 连接，用本地 IPC 承载真实 HTTP；远端地址由测试显式模拟。
  http.server.prependListener('connection', (socket) => Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress }));
  try {
    await new Promise<void>((resolve, reject) => { http.server.once('error', reject); http.server.listen(socketPath, resolve); });
    const host = '127.0.0.1:3000';
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ socketPath, agent: false, method, path: `/api/v1${path}`, headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const input = { name: 'first', baseUrl: 'https://example.com/v1', apiKey: 'secret', apiProtocol: 'chat_completions' };
    expect((await call('GET', '/models', undefined, { Host: '192.168.0.2:3000', Origin: 'http://evil.example' })).status).toBe(200);
    expect((await call('GET', '/model-key-envs')).body).toEqual({ variables: [] });
    expect((await call('GET', '/model-key-envs', undefined, { Origin: 'http://evil.example' })).status).toBe(403);
    const registry = join(dir, 'model-key-envs.json');
    writeFileSync(registry, '{broken');
    expect((await call('GET', '/model-key-envs')).status).toBe(400);
    expect((await call('POST', '/models', { ...input, apiKey: '', apiKeyEnv: 'WEREWOLF_TEST_MISSING' })).body.message).toContain('模型密钥变量配置无效');
    expect(readFileSync(registry, 'utf8')).toBe('{broken');
    writeFileSync(registry, JSON.stringify({ variables: ['WEREWOLF_TEST_MISSING'] }));
    expect((await call('GET', '/model-key-envs')).body).toEqual({ variables: [{ name: 'WEREWOLF_TEST_MISSING', available: false }] });
    remoteAddress = '192.168.0.2';
    expect((await call('POST', '/models', input)).status).toBe(403);
    expect((await call('GET', '/model-key-envs')).status).toBe(403);
    remoteAddress = '127.0.0.1';
    expect((await call('POST', '/models', input, { Host: '192.168.0.2:3000' })).status).toBe(403);
    expect((await call('POST', '/models', input, { Origin: 'http://evil.example' })).status).toBe(403);
    const added = await call('POST', '/models', input);
    expect(added.status).toBe(201);
    const path = `/models/${added.body.id}`;
    expect((await call('PUT', path, { ...input, name: 'changed', apiKey: '' }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('DELETE', path, undefined, { Host: '192.168.0.2:3000' })).status).toBe(403);
    expect((await call('PUT', path, { ...input, name: 'changed', apiKey: '' })).body).toMatchObject({ label: 'changed', hasKey: true });
    expect((await call('DELETE', path)).status).toBe(200);
    expect((await call('GET', '/models')).body).toEqual([]);

    const draft = { name: 'speech', kind: 'speech-compatible', url: 'https://speech.example/v1/audio/speech', apiKey: 'fixture-speech-key' };
    const addedSpeech = await call('POST', '/speech-settings', draft);
    expect(addedSpeech.status).toBe(201);
    const speechPath = `/speech-settings/${addedSpeech.body.id}`;
    const room = manager.createRoom();
    const privateSpeech = speechConnections.save(room.roomId, draft);
    const roomHeaders = { Authorization: `Bearer ${room.hostToken}` };
    const sharePath = `/rooms/${room.roomId}/speech-settings/${privateSpeech.id}/share`;
    const before = readFileSync(join(dir, 'speech.json'), 'utf8');
    remoteAddress = '192.168.0.2';
    for (const [method, endpoint] of [['GET', '/speech-settings'], ['POST', '/speech-settings'], ['PUT', speechPath], ['DELETE', speechPath], ['POST', `${speechPath}/test`], ['POST', sharePath]]) {
      expect((await call(method, endpoint, method === 'GET' || method === 'DELETE' ? undefined : draft, roomHeaders)).status, `${method} ${endpoint}`).toBe(403);
    }
    expect(render).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'speech.json'), 'utf8')).toBe(before);
    expect((await call('GET', `/rooms/${room.roomId}/speech-settings`, undefined, roomHeaders)).status).toBe(200);
    const catalog = await call('GET', `/rooms/${room.roomId}/speech-providers`, undefined, roomHeaders);
    expect(catalog.body.providers).toContainEqual({ id: addedSpeech.body.id, label: draft.name });
    expect(JSON.stringify(catalog.body)).not.toContain(draft.apiKey);
    expect(JSON.stringify(catalog.body)).not.toContain(draft.url);
    remoteAddress = '127.0.0.1';
    expect((await call('PUT', speechPath, draft, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('PUT', speechPath, { ...draft, name: 'changed', apiKey: '' })).body).toMatchObject({ name: 'changed', hasKey: true });
    expect((await call('GET', '/speech-settings')).body.connections).toHaveLength(1);
    expect((await call('POST', `${speechPath}/test`)).status).toBe(503);
    expect(render).toHaveBeenCalledTimes(1);
    expect((await call('POST', sharePath, undefined, roomHeaders)).status).toBe(200);
    expect((await call('DELETE', speechPath)).status).toBe(200);
  } finally {
    await http.close();
    render.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
