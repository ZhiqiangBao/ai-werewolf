import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { attachEventStream } from '../src/event-stream';
import { shutdownResources, type ShutdownPorts } from '../src/shutdown';

afterEach(() => vi.useRealTimers());

function ports(log: string[], report = true): ShutdownPorts {
  return {
    stopAccepting: async () => { log.push('stop'); },
    closeStreams: () => { log.push('streams'); },
    dispose: () => { log.push('dispose'); },
    whenDisposed: async () => { log.push('manager'); return { durable: report }; },
    closeFrontend: async () => { log.push('frontend'); },
    forceConnections: () => { log.push('force'); },
    release: () => { log.push('lease'); }, graceMs: 5000,
  };
}

it('正常退出先停止接入、关闭流、释放管理器，等待后释放租约', async () => {
  const log: string[] = [];
  expect(await shutdownResources(ports(log))).toBe(0);
  expect(log).toEqual(['stop', 'streams', 'dispose', 'manager', 'frontend', 'lease']);
});

it('保存或关闭失败返回失败状态，仍等待其他资源并释放租约', async () => {
  const log: string[] = [], p = ports(log, false);
  p.stopAccepting = () => Promise.reject(new Error('synthetic'));
  expect(await shutdownResources(p)).toBe(1);
  expect(log).toContain('frontend'); expect(log.at(-1)).toBe('lease');
});

it('超过宽限强制关闭连接并返回超时状态', async () => {
  vi.useFakeTimers(); const log: string[] = [], p = ports(log);
  p.whenDisposed = () => new Promise(() => {});
  const result = shutdownResources(p); await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBe(2); expect(log.slice(-2)).toEqual(['force', 'lease']);
});

it('SSE 断开或主动关闭均清理 ping、监听器和订阅，重复关闭安全', () => {
  vi.useFakeTimers(); const req = new EventEmitter(); let ended = false;
  const res = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(() => { ended = true; }), get writableEnded() { return ended; } };
  const streams = new Set<() => void>(), unsubscribe = vi.fn();
  attachEventStream(req as IncomingMessage, res as unknown as ServerResponse, unsubscribe, streams);
  expect(vi.getTimerCount()).toBe(1); expect(req.listenerCount('close')).toBe(1);
  const close = [...streams][0]; close(); close(); req.emit('close');
  expect(unsubscribe).toHaveBeenCalledTimes(1); expect(res.end).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0); expect(req.listenerCount('close')).toBe(0); expect(streams.size).toBe(0);
});
