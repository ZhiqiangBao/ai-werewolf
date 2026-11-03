import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error The standalone Node.js CLI is intentionally JavaScript.
import { matchesLegacyProcess } from '../../../scripts/service.mjs';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
    try { await access(join(dir, '.writer-lease')); throw new Error(`Test service still owns ${dir}; leaving its data intact`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rm(dir, { recursive: true, force: true });
  }
});
const temporary = async () => { const dir = await mkdtemp(join(tmpdir(), 'werewolf-service-')); dirs.push(dir); return dir; };
const run = (executable: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; out: string }>((done, fail) => {
  const p = spawn(executable, args, { cwd: process.cwd(), env: { ...process.env, ...env }, windowsHide: true });
  let out = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
  p.on('error', fail); p.on('close', (code) => done({ code, out }));
});
const command = (action: string, env: NodeJS.ProcessEnv) => {
  const entry = process.env.npm_execpath;
  if (entry && /pnpm/i.test(entry)) return run(process.execPath, [entry, action], env);
  return process.platform === 'win32'
    ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `pnpm.cmd ${action}`], env)
    : run('pnpm', [action], env);
};
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as AddressInfo).port; await new Promise<void>((done) => server.close(() => done())); return port; }

describe('service management', () => {
  it('checks legacy process start time, working directory and executable entry', () => {
    const owner = { pid: 42, startedAt: '2026-11-03T05:39:55.651Z' };
    const root = process.cwd();
    const info = { pid: 42, startedAt: owner.startedAt, cwd: root, commandLine: '"C:/Program Files/nodejs/node.exe" --import tsx apps/server/src/main.ts --dev' };
    expect(matchesLegacyProcess(info, owner, root)).toBe(true);
    expect(matchesLegacyProcess({ ...info, startedAt: 'invalid' }, owner, root)).toBe(false);
    expect(matchesLegacyProcess({ ...info, cwd: join(root, 'elsewhere') }, owner, root)).toBe(false);
    expect(matchesLegacyProcess({ ...info, commandLine: 'node.exe unrelated.js' }, owner, root)).toBe(false);
    expect(matchesLegacyProcess({ ...info, pid: 43 }, owner, root)).toBe(false);
  });
  it('starts, checks, restarts and gracefully stops with a temporary data directory', async () => {
    const dir = await temporary(), port = await freePort();
    const env = { WEREWOLF_DATA: dir, PORT: String(port), HOST: '127.0.0.1' };
    try {
      const first = await command('restart', env); expect(first, first.out).toMatchObject({ code: 0 });
      const firstLease = JSON.parse(await readFile(join(dir, '.writer-lease'), 'utf8'));
      const state = await command('status', env); expect(state, state.out).toMatchObject({ code: 0 }); expect(state.out).toContain('服务运行中');
      const next = await command('restart', env); expect(next, next.out).toMatchObject({ code: 0 });
      const nextLease = JSON.parse(await readFile(join(dir, '.writer-lease'), 'utf8'));
      expect(nextLease.pid).not.toBe(firstLease.pid);
      const metadata = JSON.parse(await readFile(join(dir, '.service-control.json'), 'utf8')); expect(metadata.host).toBe('127.0.0.1');
    } finally {
      const stopped = await command('stop', env); expect(stopped, stopped.out).toMatchObject({ code: 0 });
    }
    await expect(readFile(join(dir, '.writer-lease'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 45000);
  it('never stops an unrelated listener on the selected port', async () => {
    const dir = await temporary(), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const result = await command('restart', { WEREWOLF_DATA: dir, PORT: String((server.address() as AddressInfo).port), HOST: '127.0.0.1' });
      expect(result.code).not.toBe(0);
      if (process.platform === 'win32') expect(result.out).toContain('其他进程');
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  }, 20000);
  it('rejects an invalid control token and waits for authenticated cleanup beyond three seconds', async () => {
    const dir = await temporary();
    const fixture = `
      import fs from 'node:fs';
      import { join } from 'node:path';
      import { startLocalControl } from ${JSON.stringify(pathToFileURL(resolve('apps/server/src/local-control.ts')).href)};
      const data = process.env.WEREWOLF_CONTROL_TEST_DIR;
      const file = join(data, '.writer-lease');
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: 'a'.repeat(32) }));
      process.once('exit', () => fs.unlinkSync(file));
      startLocalControl(data, process.cwd(), 'dev', '127.0.0.1', 5173,
        () => new Promise(done => setTimeout(() => done(0), 3300)));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], {
      env: { ...process.env, WEREWOLF_CONTROL_TEST_DIR: dir }, windowsHide: true, stdio: 'ignore',
    });
    const exited = once(child, 'exit');
    try {
      let port = 0;
      for (let i = 0; i < 100 && !port; i++) {
        try { port = JSON.parse(await readFile(join(dir, '.service-control.json'), 'utf8')).controlPort; }
        catch { await new Promise(done => setTimeout(done, 50)); }
      }
      expect(port).toBeGreaterThan(0);
      const request = (token: string) => new Promise<string>((done, fail) => {
        const socket = createConnection({ host: '127.0.0.1', port }); let reply = '';
        socket.setTimeout(8000, () => socket.destroy(new Error('Control request timed out')));
        socket.on('connect', () => socket.write(token + '\n'));
        socket.on('data', chunk => { reply += chunk.toString(); });
        socket.on('error', fail); socket.on('end', () => done(reply.trim()));
      });
      expect(await request('invalid')).toBe('DENIED');
      const before = Date.now();
      expect(await request('a'.repeat(32))).toBe('0');
      expect(Date.now() - before).toBeGreaterThanOrEqual(3000);
      expect((await exited)[0]).toBe(0);
    } finally { if (child.exitCode === null) child.kill(); }
  }, 15000);
});
