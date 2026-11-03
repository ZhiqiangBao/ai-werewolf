import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, closeSync, fstatSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 锁无法证明失效时不抢占；异常退出遗留锁必须人工核实后移除。 */
export function acquireDataLease(directory: string, io: { write: typeof writeFileSync; close: typeof closeSync } = { write: writeFileSync, close: closeSync }): () => void {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, '.writer-lease');
  const owner = { pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), nonce: randomBytes(16).toString('hex') };
  let fd: number;
  try { fd = openSync(file, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('MODEL_STORE_BUSY');
    throw error;
  }
  let identity: { dev: bigint; ino: bigint } | undefined;
  try {
    const stat = fstatSync(fd, { bigint: true });
    identity = { dev: stat.dev, ino: stat.ino };
    io.write(fd, JSON.stringify(owner));
    io.close(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* close 可能已经完成。 */ }
    try {
      const current = lstatSync(file, { bigint: true });
      // 无法证明是刚创建的同一文件时保留它供人工检查。
      if (identity && identity.ino !== 0n && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(file);
    } catch { /* 文件已不存在或无法验证时不扩大清理范围。 */ }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    const current = JSON.parse(readFileSync(file, 'utf8')) as typeof owner;
    if (current.nonce !== owner.nonce) throw new Error('MODEL_STORE_BUSY');
    unlinkSync(file);
    released = true;
  };
}
