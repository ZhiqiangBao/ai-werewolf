import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** 控制端仅绑定本机；验证当前数据租约密钥后才请求正常收尾。 */
export function startLocalControl(data: string, root: string, mode: string, host: string, port: number, shutdown: () => Promise<number>): void {
  const lease = JSON.parse(readFileSync(join(data, '.writer-lease'), 'utf8')) as { pid: number; nonce: string };
  if (lease.pid !== process.pid || !/^[a-f0-9]{32}$/.test(lease.nonce)) throw new Error('Invalid data lease');
  const file = join(data, '.service-control.json');
  const control = createServer((socket) => {
    let input = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      if (input.length > 256) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      const token = Buffer.from(input.split('\n')[0]);
      const expected = Buffer.from(lease.nonce);
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) { socket.end('DENIED\n'); return; }
      socket.setTimeout(0);
      socket.removeAllListeners('data');
      control.close();
      void shutdown().then((code) => socket.end(`${code}\n`, () => process.exit(code)), () => socket.end('1\n', () => process.exit(1)));
    });
  });
  control.on('error', (error) => console.error('本机控制接口不可用：', error));
  control.listen(0, '127.0.0.1', () => {
    const address = control.address();
    if (!address || typeof address === 'string') return;
    const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, root, data, mode, host, port, controlPort: address.port }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) { try { unlinkSync(tmp); } catch { /* 不留无关临时文件。 */ } console.error('本机控制信息写入失败：', error); }
  });
  process.once('exit', () => {
    try {
      const current = JSON.parse(readFileSync(file, 'utf8')) as { pid: number };
      if (current.pid === process.pid) unlinkSync(file);
    } catch { /* 文件不存在或不属于本进程。 */ }
  });
}
