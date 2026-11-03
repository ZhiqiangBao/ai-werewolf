import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const hash = (kind: 'sha1' | 'sha256', value: Buffer | string) => createHash(kind).update(value).digest('hex');
const git = (b: Buffer) => hash('sha1', Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));
const asrDir = resolve('scripts/asr');

async function fixture() {
  const base = resolve('data/local-asr-register-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-')), model = join(root, 'model'), data = join(root, 'data'), runtime = join(root, 'runtime');
  await mkdir(model); await mkdir(data); await mkdir(runtime);
  const config = Buffer.from('small model config'), weights = Buffer.from('small model weights');
  await writeFile(join(model, 'config.json'), config); await writeFile(join(model, 'weights.bin'), weights);
  await writeFile(join(model, 'unused-LICENSE'), 'ignore');
  const dllName = 'native/transcribe-native-windows-x86_64-cpu-vulkan/transcribe.dll', pyName = 'python/transcribe_cpp/__init__.py';
  const dll = Buffer.from('fixture dll'), py = Buffer.from('fixture bindings');
  await mkdir(join(runtime, 'native/transcribe-native-windows-x86_64-cpu-vulkan'), { recursive: true });
  await mkdir(join(runtime, 'python/transcribe_cpp'), { recursive: true });
  await writeFile(join(runtime, dllName), dll); await writeFile(join(runtime, pyName), py);
  const manifest = Buffer.from(JSON.stringify({ release: 'v0.4.1', files: [{ file: dllName, bytes: dll.length, sha256: hash('sha256', dll) }, { file: pyName, bytes: py.length, sha256: hash('sha256', py) }] }));
  const trusted = join(root, 'trusted.json'); await writeFile(trusted, manifest);
  const cfg = { expected: { 'config.json': [config.length, git(config)], 'weights.bin': [weights.length, hash('sha256', weights)] }, ggufFile: 'weights.bin', ggufSha: hash('sha256', weights), ggufSize: weights.length, trusted, trustedHash: hash('sha256', manifest) };
  // Patch only the imported module in this test process; production has no fixture override.
  const python = `import sys,json,os\nsys.path.insert(0,${JSON.stringify(asrDir)})\nimport server,register\nc=json.loads(${JSON.stringify(JSON.stringify(cfg))})\nserver.EXPECTED={k:tuple(v) for k,v in c['expected'].items()}\nserver.GGUF_FILE=c['ggufFile'];server.GGUF_SHA=c['ggufSha'];server.GGUF_SIZE=c['ggufSize']\nserver.RUNTIME_MANIFEST_SHA=c['trustedHash'];register.RUNTIME_COPY=register.Path(c['trusted'])\nif os.getenv('ASR_TEST_REPLACE_FAIL')=='1':\n register.os.replace=lambda *args: (_ for _ in ()).throw(OSError('simulated replace failure'))\nstatus=register.main()\nif status==0:\n os.environ['WEREWOLF_ASR_MODEL_DIR']=sys.argv[sys.argv.index('--model-dir')+1]\n server.verify_model(register.Path(sys.argv[sys.argv.index('--data-dir')+1]),sys.argv[sys.argv.index('--backend')+1])\nsys.exit(status)\n`;
  const call = (backend: 'transformers' | 'gguf', extra: string[] = [], env: NodeJS.ProcessEnv = {}) => spawnSync(process.env.ASR_TEST_PYTHON || 'python', ['-c', python, '--backend', backend, '--model-dir', model, '--data-dir', data, ...(backend === 'gguf' ? ['--runtime-dir', runtime] : []), ...extra], { cwd: asrDir, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  return { root, model, data, runtime, manifest, call };
}

describe('离线注册固定版本的本地 ASR', () => {
  it('核对 SHA256 和 Git blob，生成服务可读清单；再次注册不改已有文件', async () => {
    const f = await fixture(), target = join(f.data, 'local-asr', 'model-manifest.json');
    const first = f.call('transformers'); expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ backend: 'transformers', created: true });
    const before = await readFile(target), doc = JSON.parse(before.toString());
    expect(doc.files.map((entry: { file: string }) => entry.file)).toEqual(['config.json', 'weights.bin']);
    const second = f.call('transformers'); expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).created).toBe(false); expect(await readFile(target)).toEqual(before);
  });
  it('错误路径或摘要不能创建成功清单，已有不匹配清单原样保留', async () => {
    const f = await fixture(), target = join(f.data, 'local-asr', 'model-manifest.json');
    await writeFile(join(f.model, 'config.json'), 'bad checksum');
    expect(f.call('transformers').status).not.toBe(0); expect(existsSync(target)).toBe(false);
    expect(f.call('transformers', ['--model-dir', 'relative']).status).not.toBe(0); expect(existsSync(target)).toBe(false);
    await writeFile(join(f.model, 'config.json'), 'small model config');
    await mkdir(join(f.data, 'local-asr')); await writeFile(target, 'existing user manifest');
    const conflict = f.call('transformers'); expect(conflict.status).not.toBe(0); expect(conflict.stderr).toMatch(/not overwritten/);
    expect(await readFile(target, 'utf8')).toBe('existing user manifest');
  });
  it('GGUF 在核对全部运行时文件后写入可信清单，幂等且拒绝冲突', async () => {
    const f = await fixture(), runtimeManifest = join(f.runtime, 'runtime-manifest.json'), target = join(f.data, 'local-asr', 'model-manifest.gguf.json');
    const first = f.call('gguf'); expect(first.status, first.stderr).toBe(0);
    expect(await readFile(runtimeManifest)).toEqual(f.manifest);
    expect(JSON.parse(await readFile(target, 'utf8')).files).toHaveLength(1);
    const second = f.call('gguf'); expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).created).toBe(false);
    await writeFile(runtimeManifest, 'different existing manifest');
    expect(f.call('gguf').status).not.toBe(0);
    expect(await readFile(runtimeManifest, 'utf8')).toBe('different existing manifest');
  });
  it('缺失或损坏运行时、额外绑定以及模型清单冲突均不会留下新清单', async () => {
    for (const defect of ['missing', 'corrupt', 'extra', 'conflict'] as const) {
      const f = await fixture(), runtimeManifest = join(f.runtime, 'runtime-manifest.json'), target = join(f.data, 'local-asr', 'model-manifest.gguf.json');
      const dll = join(f.runtime, 'native/transcribe-native-windows-x86_64-cpu-vulkan/transcribe.dll');
      if (defect === 'missing') { const { unlink } = await import('node:fs/promises'); await unlink(dll); }
      if (defect === 'corrupt') await writeFile(dll, 'corrupt dll');
      if (defect === 'extra') await writeFile(join(f.runtime, 'python/transcribe_cpp/extra.py'), 'bad');
      if (defect === 'conflict') { await mkdir(join(f.data, 'local-asr')); await writeFile(target, 'old user file'); }
      const result = f.call('gguf'); expect(result.status, defect).not.toBe(0);
      expect(existsSync(runtimeManifest), defect).toBe(false);
      if (defect === 'conflict') expect(await readFile(target, 'utf8')).toBe('old user file');
      else expect(existsSync(target), defect).toBe(false);
    }
  });
  it('显式替换后保留原始备份，不改设置，重复注册不新增备份', async () => {
    const f = await fixture(), control = join(f.data, 'local-asr'), target = join(control, 'model-manifest.gguf.json'), settings = join(control, 'service-settings.json');
    const old = Buffer.from('{"quantization":"Q5_K_M","old":true}\n');
    await mkdir(control); await writeFile(target, old); await writeFile(settings, '{"backend":"gguf","modelDir":"old"}');
    const result = f.call('gguf', ['--replace']); expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ created: false, replaced: true });
    expect(await readFile(report.backup)).toEqual(old);
    expect(JSON.parse(await readFile(target, 'utf8')).files[0]).toMatchObject({ file: 'weights.bin' });
    expect(await readFile(settings, 'utf8')).toBe('{"backend":"gguf","modelDir":"old"}');
    const again = f.call('gguf', ['--replace']); expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ created: false, replaced: false, backup: null });
    expect((await readdir(control)).filter(name => name.includes('.backup-'))).toHaveLength(1);
  });
  it.each(['model', 'runtime', 'atomic'] as const)('替换失败（%s）不会覆盖旧清单或更改设置', async (defect) => {
    const f = await fixture(), control = join(f.data, 'local-asr'), target = join(control, 'model-manifest.gguf.json'), settings = join(control, 'service-settings.json');
    const old = 'previous manifest'; await mkdir(control); await writeFile(target, old); await writeFile(settings, 'previous settings');
    if (defect === 'model') await writeFile(join(f.model, 'weights.bin'), 'bad');
    if (defect === 'runtime') await writeFile(join(f.runtime, 'native/transcribe-native-windows-x86_64-cpu-vulkan/transcribe.dll'), 'bad');
    const result = f.call('gguf', ['--replace'], defect === 'atomic' ? { ASR_TEST_REPLACE_FAIL: '1' } : {});
    expect(result.status).not.toBe(0);
    expect(await readFile(target, 'utf8')).toBe(old);
    expect(await readFile(settings, 'utf8')).toBe('previous settings');
    expect(existsSync(join(f.runtime, 'runtime-manifest.json'))).toBe(false);
    const names = await readdir(control);
    expect(names.filter(name => name.includes('.tmp-'))).toHaveLength(0);
    expect(names.filter(name => name.includes('.backup-'))).toHaveLength(defect === 'atomic' ? 1 : 0);
    if (defect === 'atomic') expect(await readFile(join(control, names.find(name => name.includes('.backup-'))!), 'utf8')).toBe(old);
  });
});
