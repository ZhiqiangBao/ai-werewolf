import { AsyncLocalStorage } from 'node:async_hooks';

/** A context belongs to one adapter call, never to a room or to the process. */
export interface SyntheticCallContext<T> {
  attemptId?: string;
  plan: (attemptId: string) => T;
  fallbackId?: () => string;
}

export function createSyntheticFetch<T>(options: {
  origins: readonly string[];
  register: (origin: string, attemptId: string, plan: T) => Promise<void>;
  fetch?: typeof fetch;
}) {
  const allowed = new Set(options.origins.map((origin) => {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Synthetic fetch only accepts runner-created 127.0.0.1 HTTP origins');
    return url.origin;
  }));
  const storage = new AsyncLocalStorage<SyntheticCallContext<T>>();
  const underlying = options.fetch ?? globalThis.fetch;
  const wrapped: typeof fetch = async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    if (requestUrl.username || requestUrl.password || !allowed.has(requestUrl.origin)) throw new Error('Synthetic fetch refused a non-runner origin');
    const context = storage.getStore();
    const attemptId = context?.attemptId ?? context?.fallbackId?.();
    if (!context || !attemptId) throw new Error('Synthetic fetch requires an observed HTTP attempt in the call context');
    // The observer sets this again for every retry/variant, before its fetch.
    context.attemptId = undefined;
    await options.register(requestUrl.origin, attemptId, context.plan(attemptId));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-synthetic-attempt-id', attemptId);
    return underlying(input, { ...init, headers });
  };
  return {
    fetch: wrapped,
    run<R>(plan: (attemptId: string) => T, fn: () => R, fallbackId?: () => string): R { return storage.run({ plan, fallbackId }, fn); },
    /** Called synchronously by the adapter observation port on http_attempt start. */
    setAttempt(attemptId: string): void {
      const context = storage.getStore();
      if (!context || context.attemptId) throw new Error('No synthetic call context or attempt already pending');
      context.attemptId = attemptId;
    },
  };
}
