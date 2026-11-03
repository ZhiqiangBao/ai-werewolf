import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const action = args.shift();
let dataDir = process.env.WEREWOLF_DATA || path.join(project, 'data');
let port = Number(process.env.WEREWOLF_ASR_PORT || 5291);
const explicit = {};
let testBackend = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--data-dir') dataDir = args[++i];
  else if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--device') explicit.device = args[++i];
  else if (args[i] === '--backend') explicit.backend = args[++i];
  else if (args[i] === '--model-dir') explicit.modelDir = args[++i];
  else if (args[i] === '--python') explicit.python = args[++i];
  else if (args[i] === '--bindings-dir') explicit.bindings = args[++i];
  else if (args[i] === '--library') explicit.library = args[++i];
  else if (args[i] === '--test-backend') testBackend = true;
  else throw new Error(`Unknown argument: ${args[i]}`);
}
if (!['start', 'stop', 'status', 'restart'].includes(action) || !dataDir || !Number.isInteger(port) || port < 1 || port > 65535 || Object.values(explicit).some(value => !value)) {
  throw new Error('Usage: node scripts/asr/service.mjs start|stop|status|restart [--data-dir PATH] [--port PORT] [--backend transformers|gguf] [--device cuda:0|gpu|cpu] [--model-dir PATH] [--python PATH] [--bindings-dir PATH] [--library PATH]');
}
dataDir = path.resolve(dataDir);
const dir = path.join(dataDir, 'local-asr');
const stateFile = path.join(dir, 'service-state.json');
const controlFile = path.join(dir, 'service-control.json');
const lockFile = path.join(dir, 'service-command.lock');
const logFile = path.join(dir, 'service.log');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

async function resolveConfiguration() {
  let settings = {};
  try {
    settings = JSON.parse(await readFile(path.join(dir, 'service-settings.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read service-settings.json: invalid JSON or inaccessible file.');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('service-settings.json must be an object.');
  for (const key of ['backend', 'device', 'modelDir', 'python', 'bindings', 'library']) {
    if (key in settings && (typeof settings[key] !== 'string' || !settings[key])) throw new Error(`Invalid service setting ${key}.`);
  }
  for (const key of ['modelDir', 'python', 'bindings', 'library']) {
    if (settings[key] && !path.isAbsolute(settings[key])) throw new Error(`Service setting ${key} must be an absolute path.`);
  }
  const backend = explicit.backend || process.env.WEREWOLF_ASR_BACKEND || settings.backend || 'transformers';
  const settingsMatchBackend = !settings.backend || settings.backend === backend;
  const device = explicit.device || process.env.WEREWOLF_ASR_DEVICE || (settingsMatchBackend && settings.device) || (backend === 'gguf' ? 'gpu' : 'cuda:0');
  const modelDir = explicit.modelDir || process.env.WEREWOLF_ASR_MODEL_DIR || (settingsMatchBackend && settings.modelDir) || null;
  const python = explicit.python || process.env.WEREWOLF_ASR_PYTHON || settings.python || 'python';
  const bindings = explicit.bindings || process.env.WEREWOLF_ASR_BINDINGS_DIR || settings.bindings || null;
  const library = explicit.library || process.env.TRANSCRIBE_LIBRARY || settings.library || null;
  if (!['transformers', 'gguf'].includes(backend) || !(backend === 'gguf' ? ['gpu', 'cpu'] : ['cuda:0', 'cpu']).includes(device)) throw new Error('Device is incompatible with selected ASR backend.');
  for (const [name, value] of Object.entries({ modelDir, bindings, library })) {
    if (value && !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  }
  return { backend, device, modelDir, python, bindings, library, testBackend };
}

async function request(endpoint, token, method = 'GET', targetPort = port) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: targetPort, path: endpoint, method,
      headers: { Authorization: `Bearer ${token}`, Connection: 'close' }, timeout: 1500 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(); });
      res.on('end', () => { try { resolve({ code: res.statusCode, body: JSON.parse(body) }); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

async function owned() {
  const state = await readJson(stateFile);
  const control = await readJson(controlFile);
  if (!state || !control || state.dataDir !== dataDir || state.project !== project || state.nonce !== control.nonce || typeof control.token !== 'string') return null;
  const response = await request('/health', control.token, 'GET', state.port);
  if (response?.code !== 200 || response.body.nonce !== state.nonce || response.body.pid !== state.pid) return null;
  return { state, control, health: response.body };
}

async function portAvailable(targetPort) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: targetPort, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function start() {
  const configuration = await resolveConfiguration();
  const { backend, device, python, modelDir, bindings, library } = configuration;
  const current = await owned();
  if (current) {
    if (current.state.port !== port) throw new Error(`Service already owns port ${current.state.port}; stop it before changing ports.`);
    if (JSON.stringify(current.state.configuration) !== JSON.stringify(configuration)) throw new Error('Service already runs with different settings; restart explicitly to change configuration.');
    console.log(JSON.stringify({ ...current.health, endpoint: `http://127.0.0.1:${current.state.port}` }));
    return;
  }
  const staleState = await readJson(stateFile);
  if (staleState && Number.isInteger(staleState.port) && staleState.port !== port && !(await portAvailable(staleState.port))) {
    throw new Error(`A previous service record refers to occupied port ${staleState.port}; inspect it before replacing the record.`);
  }
  if (!(await portAvailable(port))) throw new Error(`Port ${port} is occupied by another process; no process was stopped.`);
  if (testBackend && (await readFile(path.join(dir, 'TEST-ONLY'), 'utf8').catch(() => '')) !== 'isolated test backend\n') throw new Error('Test backend requires an explicit isolated test marker.');
  const nonce = randomBytes(24).toString('hex');
  const token = randomBytes(32).toString('hex');
  await writeFile(controlFile, JSON.stringify({ nonce, token }), { mode: 0o600 });
  const log = await open(logFile, 'a', 0o600);
  const script = path.join(project, 'scripts/asr/server.py');
  const env = { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', DO_NOT_TRACK: '1', PYTHONUNBUFFERED: '1' };
  if (modelDir) env.WEREWOLF_ASR_MODEL_DIR = modelDir;
  if (bindings) env.WEREWOLF_ASR_BINDINGS_DIR = bindings;
  if (library) env.TRANSCRIBE_LIBRARY = library;
  const child = spawn(python, [script, '--data-dir', dataDir, '--port', String(port), '--device', device, '--backend', backend, ...(testBackend ? ['--test-backend'] : [])], {
    cwd: project, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env,
  });
  child.on('error', () => {});
  await log.close();
  if (!child.pid) throw new Error(`Could not start Python. Check ${logFile}`);
  const state = { pid: child.pid, nonce, startedAt: new Date().toISOString(), project, dataDir, port, backend, device, testBackend, configuration, endpoint: `http://127.0.0.1:${port}` };
  await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  child.unref();
  console.log('Local ASR loading; initial checksum and model load may take up to 120 seconds.');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const current = await owned();
    if (current?.health.status === 'ready') {
      console.log(JSON.stringify({ ...current.health, endpoint: state.endpoint }));
      return;
    }
    if (current?.health.status === 'failed') {
      await request('/shutdown', token, 'POST', port);
      throw new Error(`Local ASR loading failed: ${current.health.error}. Check ${logFile}`);
    }
    try { process.kill(child.pid, 0); } catch { throw new Error(`Local ASR exited during startup. Check ${logFile}`); }
    await sleep(500);
  }
  const currentAfterTimeout = await owned();
  if (currentAfterTimeout) await request('/shutdown', token, 'POST', port);
  throw new Error(`Local ASR startup timed out. Check ${logFile}`);
}

async function stop() {
  const current = await owned();
  if (!current) { console.log('No matching running local ASR service. No process was stopped.'); return; }
  const result = await request('/shutdown', current.control.token, 'POST', current.state.port);
  if (result?.code !== 200 || result.body.pid !== current.state.pid || result.body.nonce !== current.state.nonce) throw new Error('Shutdown was not acknowledged by the matching service.');
  for (let i = 0; i < 40; i++) {
    if (!(await owned())) {
      await unlink(stateFile).catch(() => {});
      await unlink(controlFile).catch(() => {});
      console.log('Local ASR stopped.');
      return;
    }
    await sleep(100);
  }
  throw new Error('Service acknowledged shutdown but is still responding; no process was killed.');
}

async function main() {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (action === 'status') {
    const current = await owned();
    console.log(current ? JSON.stringify({ ...current.health, endpoint: current.state.endpoint }) : 'No matching running local ASR service.');
    return;
  }
  let lock;
  try {
    lock = await open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another service command is active, or its lock remains at ${lockFile}; inspect it before removing.`);
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    if (action === 'start') await start();
    else if (action === 'stop') await stop();
    else { await stop(); await start(); }
  } finally {
    await lock.close();
    await unlink(lockFile).catch(() => {});
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
