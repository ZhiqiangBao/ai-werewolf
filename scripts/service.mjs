import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.WEREWOLF_DATA || join(root, 'data'));
const leaseFile = join(data, '.writer-lease');
const controlFile = join(data, '.service-control.json');
const commandFile = join(data, '.service-command.lock');
const logFile = join(data, 'service.log');
const settingsFile = join(data, '.service-settings.json');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const samePath = (a, b) => resolve(a).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() === resolve(b).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`无法读取 ${file}，请检查文件。`); } }
function lease() {
  const value = readJson(leaseFile);
  if (value && (!Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[a-f0-9]{32}$/.test(value.nonce) || !Number.isFinite(Date.parse(value.startedAt)))) throw new Error('数据租约格式异常，请人工检查；未停止任何进程。');
  return value;
}
function control(owner) {
  const value = readJson(controlFile);
  if (!value) return null;
  if (!owner || value.pid !== owner.pid || typeof value.root !== 'string' || typeof value.data !== 'string' || typeof value.host !== 'string' || !value.host || !samePath(value.root, root) || !samePath(value.data, data) || !Number.isInteger(value.controlPort) || value.controlPort < 1 || value.controlPort > 65535 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !['dev', 'production'].includes(value.mode)) throw new Error('本机控制信息与租约不匹配，请人工检查；未停止任何进程。');
  return value;
}
function settings() {
  const value = readJson(settingsFile);
  if (!value) return null;
  if (!['dev', 'production'].includes(value.mode) || typeof value.host !== 'string' || !value.host || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('保存的服务设置无效，请人工检查。');
  return { mode: value.mode, host: value.host, port: value.port };
}
function saveSettings(value) {
  const tmp = `${settingsFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mode: value.mode, host: value.host, port: value.port }), { mode: 0o600 });
  renameSync(tmp, settingsFile);
}
function processGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw new Error('无法确认进程状态；保留所有锁文件。'); }
}
function recoverStaleLease() {
  const owner = lease();
  if (!owner || !processGone(owner.pid)) return;
  const meta = control(owner);
  const current = lease();
  if (!current || current.pid !== owner.pid || current.nonce !== owner.nonce) throw new Error('租约已改变，停止后续操作。');
  if (meta) unlinkSync(controlFile);
  unlinkSync(leaseFile);
  console.log('已回收确认不再运行的服务租约。');
}
function acquireCommandLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(commandFile, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid })); return fd; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const raw = readFileSync(commandFile, 'utf8');
      let old; try { old = JSON.parse(raw); } catch { throw new Error('管理锁格式异常，请人工检查。'); }
      if (!Number.isSafeInteger(old.pid) || old.pid < 1 || !processGone(old.pid)) throw new Error('另一个服务管理命令正在执行。');
      if (readFileSync(commandFile, 'utf8') !== raw) throw new Error('管理锁已改变，请重试。');
      unlinkSync(commandFile);
    }
  }
  throw new Error('无法取得服务管理锁，请重试。');
}
export function matchesLegacyProcess(info, owner, projectRoot) {
  if (!info || info.pid !== owner.pid || typeof info.commandLine !== 'string' || typeof info.cwd !== 'string') return false;
  if (!Number.isFinite(Date.parse(info.startedAt)) || !Number.isFinite(Date.parse(owner.startedAt)) || Math.abs(Date.parse(info.startedAt) - Date.parse(owner.startedAt)) > 3000) return false;
  const command = info.commandLine.replaceAll('\\', '/').toLowerCase();
  const entry = 'apps/server/src/main.ts';
  if (!command.includes(entry) || !/(?:^|[\\/"\s])node(?:\.exe)?(?:"|\s)/i.test(command)) return false;
  const absolute = resolve(projectRoot, entry).replaceAll('\\', '/').toLowerCase();
  return command.includes(absolute) || (samePath(info.cwd, projectRoot) && /(?:^|["\s])(?:\.\/)?apps\/server\/src\/main\.ts(?:"|\s|$)/.test(command));
}
function inspectProcess(pid) {
  if (process.platform !== 'win32') throw new Error('旧服务无法自动验证进程路径，请先从原终端正常停止。');
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const env = { ...process.env, PSModulePath: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
    return JSON.parse(execFileSync(executable, ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts', 'windows-process.ps1'), String(pid)], { encoding: 'utf8', windowsHide: true, env, timeout: 12000, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { throw new Error('无法核实旧服务进程、启动时间和工作目录；未停止进程，也未移除租约。'); }
}
function listeners(port) {
  if (process.platform !== 'win32') return null;
  let output;
  try { output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }); }
  catch { throw new Error('无法核实端口归属；未停止任何进程。'); }
  return output.split(/\r?\n/).flatMap((line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP' || columns[3].toUpperCase() !== 'LISTENING' || Number(columns[1].match(/:(\d+)$/)?.[1]) !== port) return [];
    return [Number(columns[4])];
  });
}
function checkPort(port, ownerPid) {
  const pids = listeners(port);
  if (pids?.some((pid) => pid !== ownerPid)) throw new Error(`端口 ${port} 被其他进程占用；未停止该进程。`);
}
async function requestStop(meta, owner) {
  return await new Promise((resolveStop, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: meta.controlPort });
    let reply = '';
    socket.setTimeout(15000, () => socket.destroy(new Error('timeout')));
    socket.on('connect', () => socket.write(`${owner.nonce}\n`));
    socket.on('data', (chunk) => { reply += chunk.toString(); if (reply.length > 20) socket.destroy(new Error('invalid response')); });
    socket.on('error', () => reject(new Error('无法联系本项目的控制接口；未强制停止，请检查服务日志。')));
    socket.on('end', () => /^0\s*$/.test(reply) ? resolveStop() : reject(new Error('服务收尾失败或超时，请检查日志；未启动替代服务。')));
  });
}
async function waitReleased(owner) {
  for (let i = 0; i < 100; i++) {
    const current = lease();
    if (!current) return;
    if (current.nonce !== owner.nonce) throw new Error('数据租约已被其他进程接管，停止后续操作。');
    await delay(100);
  }
  throw new Error('服务未释放数据租约，请检查日志；未启动替代服务。');
}
async function stop(owner, meta, port) {
  if (!owner) { if (existsSync(controlFile)) throw new Error('控制信息缺少数据租约，请人工检查。'); console.log('服务未运行。'); return; }
  checkPort(port, owner.pid);
  if (meta) {
    saveSettings(meta);
    await requestStop(meta, owner);
    await waitReleased(owner);
    console.log('服务已正常保存并停止。');
    return;
  }
  const info = inspectProcess(owner.pid);
  if (!matchesLegacyProcess(info, owner, root)) throw new Error('旧服务的归属无法确认；未停止任何进程。');
  saveSettings({ port, host: process.env.HOST || '0.0.0.0', mode: /(?:^|\s)--dev(?:\s|$)/.test(info.commandLine) ? 'dev' : 'production' });
  console.log('发现旧版服务：没有正常收尾接口，将停止已核实的项目进程。');
  process.kill(owner.pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    try { process.kill(owner.pid, 0); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      const current = lease();
      if (current?.nonce === owner.nonce && current.pid === owner.pid) unlinkSync(leaseFile);
      else if (current) throw new Error('租约已改变，停止后续操作。');
      console.log('旧服务已停止。'); return;
    }
    await delay(100);
  }
  throw new Error('旧服务未能退出，已保留租约。');
}
const localUrl = (host, port) => `http://${['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${port}/`;
async function healthy(url) {
  const response = await fetch(`${url}api/v1/catalog`, { signal: AbortSignal.timeout(1000) });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false;
  const body = await response.json();
  return Array.isArray(body.roles) && Array.isArray(body.presets) && Array.isArray(body.options);
}
async function start(port, mode, host) {
  checkPort(port, undefined);
  if (lease()) throw new Error('数据目录仍被占用，未启动服务。');
  if (!existsSync(join(root, 'node_modules', 'tsx'))) throw new Error('未安装项目依赖，请先按 README 完成安装。');
  const fd = openSync(logFile, 'a');
  let child, spawnError;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts', ...(mode === 'dev' ? ['--dev'] : [])], { cwd: root, env: { ...process.env, HOST: host, PORT: String(port), WEREWOLF_DATA: data }, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    child.on('error', (error) => { spawnError = error; });
    child.unref();
  } finally { closeSync(fd); }
  const url = localUrl(host, port);
  for (let i = 0; i < 150; i++) {
    await delay(100);
    if (spawnError) throw new Error(`无法启动服务：${spawnError.message}`);
    const current = lease();
    if (current?.pid === child.pid) {
      const meta = control(current);
      if (meta) {
        try { if (await healthy(url)) { saveSettings({ mode, host, port }); console.log(`服务已启动：${url}\n模式：${mode}\n日志：${logFile}`); return; } } catch { /* 等待服务可用。 */ }
      }
    } else if (current) throw new Error('数据目录已被其他进程占用；请检查日志。');
  }
  throw new Error(`服务未在预期时间内就绪，请查看日志：${logFile}`);
}
async function main(action) {
  if (!['start', 'restart', 'stop', 'status'].includes(action)) throw new Error('用法：pnpm start、pnpm restart、pnpm stop 或 pnpm status。');
  const initial = lease();
  const meta = control(initial);
  const saved = settings();
  const port = Number(process.env.PORT || meta?.port || saved?.port || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 至 65535 的整数。');
  if (action === 'status') {
    if (!initial) { console.log('服务未运行。'); return; }
    if (meta) {
      try { if (!await healthy(localUrl(meta.host, meta.port))) throw new Error(); }
      catch { throw new Error('找到租约，但服务未通过健康检查；请检查日志和数据目录。'); }
      console.log(`服务运行中：${localUrl(meta.host, meta.port)}\n模式：${meta.mode}\n日志：${logFile}`);
    } else { const info = inspectProcess(initial.pid); if (!matchesLegacyProcess(info, initial, root)) throw new Error('租约对应的服务归属无法确认。'); console.log(`旧版项目服务运行中（进程 ${initial.pid}），可使用 pnpm restart 迁移到托管运行。`); }
    return;
  }
  if (action === 'start' && initial && !processGone(initial.pid)) {
    if (!meta) throw new Error('旧版服务已运行，请先执行 pnpm restart。');
    try { if (!await healthy(localUrl(meta.host, meta.port))) throw new Error(); }
    catch { throw new Error('服务未通过健康检查；未启动替代服务。'); }
    console.log(`服务已运行：${localUrl(meta.host, meta.port)}\n模式：${meta.mode}\n日志：${logFile}`);
    return;
  }
  mkdirSync(data, { recursive: true });
  const lock = acquireCommandLock();
  try {
    recoverStaleLease();
    const owner = lease(), current = control(owner);
    const desiredPort = Number(process.env.PORT || current?.port || saved?.port || port);
    if (action === 'start' && owner) throw new Error('服务状态已改变，请重试。');
    if (action === 'restart' || action === 'start') checkPort(desiredPort, desiredPort === current?.port || !current ? owner?.pid : undefined);
    if (action !== 'start') await stop(owner, current, current?.port || desiredPort);
    if (action === 'restart' || action === 'start') await start(desiredPort, current?.mode || saved?.mode || (action === 'start' ? 'production' : 'dev'), process.env.HOST || current?.host || saved?.host || '0.0.0.0');
  } finally { closeSync(lock); unlinkSync(commandFile); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]).catch((error) => { console.error(`服务管理失败：${error.message}`); process.exitCode = 1; });
