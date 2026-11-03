import { describe, expect, it, vi } from 'vitest';
import { scopedCallback, ViewLoader } from '../src/view-loader';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('视图凭证作用域', () => {
  it('切换凭证后，旧请求的成功或失败都不能发布，旧 SSE 也不能触发新请求', async () => {
    const first = deferred<string>(), next = deferred<string>();
    let current = 'a';
    const publishA = vi.fn(), publishB = vi.fn();
    const a = new ViewLoader(() => first.promise, publishA, () => current === 'a');
    const b = new ViewLoader(() => next.promise, publishB, () => current === 'b');
    a.activate(); b.activate();
    const oldRequest = a.refresh();
    const newEvent = vi.fn(() => void b.refresh());
    const oldEvent = scopedCallback(() => current === 'a', newEvent);
    current = 'b'; oldEvent();
    expect(newEvent).not.toHaveBeenCalled();
    const newRequest = b.refresh();
    next.resolve('新座位投影'); await newRequest;
    first.resolve('旧座位投影'); await oldRequest;
    expect(publishA).not.toHaveBeenCalled();
    expect(publishB).toHaveBeenCalledExactlyOnceWith('新座位投影', null);

    const lateFailure = deferred<string>(); current = 'a';
    const failing = new ViewLoader(() => lateFailure.promise, publishA, () => current === 'a');
    failing.activate(); const failedRequest = failing.refresh(); current = 'b';
    lateFailure.reject(Error('旧凭证错误')); await failedRequest;
    expect(publishA).not.toHaveBeenCalled();
  });

  it('同作用域的并发更新合并后重拉，停用后旧请求不能影响重启后的请求', async () => {
    const one = deferred<string>(), two = deferred<string>(), three = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise).mockReturnValueOnce(three.promise);
    const publish = vi.fn(), loader = new ViewLoader(load, publish, () => true);
    loader.activate(); const old = loader.refresh(); void loader.refresh();
    one.resolve('第一次'); await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    loader.deactivate(); loader.activate(); const fresh = loader.refresh();
    two.resolve('过期'); await old;
    three.resolve('重启后'); await fresh;
    expect(publish.mock.calls).toEqual([['第一次', null], ['重启后', null]]);
  });
});
