export interface ShutdownPorts {
  stopAccepting(): Promise<void>;
  closeStreams(): void;
  dispose(): void;
  whenDisposed(): Promise<{ durable: boolean }>;
  closeFrontend(): Promise<void>;
  forceConnections(): void;
  release(): void;
  graceMs: number;
}

/** 退出状态：0 正常，1 保存或释放失败，2 超过宽限。 */
export async function shutdownResources(ports: ShutdownPorts): Promise<0 | 1 | 2> {
  let failed = false;
  let serverClosed: Promise<void>;
  try { serverClosed = ports.stopAccepting(); } catch { failed = true; serverClosed = Promise.resolve(); }
  try { ports.closeStreams(); } catch { failed = true; }
  let managerClosed: Promise<{ durable: boolean }>;
  try { ports.dispose(); managerClosed = ports.whenDisposed(); }
  catch { failed = true; managerClosed = Promise.resolve({ durable: false }); }
  let frontendClosed: Promise<void>;
  try { frontendClosed = ports.closeFrontend(); } catch { failed = true; frontendClosed = Promise.resolve(); }
  const cleanup = Promise.allSettled([serverClosed, managerClosed, frontendClosed]).then((results) => results[0].status === 'fulfilled' && results[1].status === 'fulfilled' && results[1].value.durable && results[2].status === 'fulfilled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ports.graceMs); });
  const result = await Promise.race([cleanup, timeout]);
  if (timer) clearTimeout(timer);
  if (result === 'timeout') { try { ports.forceConnections(); } catch { failed = true; } }
  try { ports.release(); } catch { failed = true; }
  return result === 'timeout' ? 2 : result && !failed ? 0 : 1;
}
