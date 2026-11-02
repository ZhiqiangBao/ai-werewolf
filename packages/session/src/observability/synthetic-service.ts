import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SyntheticResponsePlan, SyntheticTruth } from './synthetic-types';
export type { SyntheticResponsePlan, SyntheticTruth } from './synthetic-types';

/** IPC carries pre-registered responses, never inspected production request bodies. */
export async function startSyntheticService(): Promise<{
  origin: string;
  register(id: string, plan: SyntheticResponsePlan): Promise<void>;
  truth: SyntheticTruth[];
  close(): Promise<void>;
}> {
  const script = fileURLToPath(new URL('../../scripts/observability-server.ts', import.meta.url));
  const child: ChildProcess = fork(script, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const truth: SyntheticTruth[] = [];
  let readyResolve!: (port: number) => void, readyReject!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.on('message', (message: { type: string; port?: number; id?: string; truth?: SyntheticTruth }) => {
    if (message.type === 'ready' && message.port) readyResolve(message.port);
    if (message.type === 'registered' && message.id) { pending.get(message.id)?.resolve(); pending.delete(message.id); }
    if (message.type === 'truth' && message.truth) truth.push(message.truth);
  });
  child.on('error', (error) => { readyReject(error); for (const p of pending.values()) p.reject(error); pending.clear(); });
  child.on('exit', (code) => {
    const error = new Error(`Synthetic server exited (${code ?? 'signal'})`);
    readyReject(error); for (const p of pending.values()) p.reject(error); pending.clear();
  });
  const port = await ready;
  return {
    origin: `http://127.0.0.1:${port}`, truth,
    register(id, plan) {
      if (pending.has(id)) return Promise.reject(new Error('Duplicate pending synthetic attempt'));
      return new Promise<void>((resolve, reject) => { pending.set(id, { resolve, reject }); child.send?.({ type: 'register', id, plan }); });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.send?.({ type: 'close' }); });
    },
  };
}
