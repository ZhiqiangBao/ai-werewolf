import { useCallback, useEffect, useRef, useState } from 'react';
import type { Catalog, ViewResponse } from '@werewolf/protocol';
import { api, streamUrl } from './api';

export function useHashRoute(): string[] {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function go(path: string): void {
  location.hash = path;
}

let catalogCache: Promise<Catalog> | null = null;

export function useCatalog(): Catalog | null {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    catalogCache ??= api.catalog();
    catalogCache.then(setCatalog).catch(() => {
      catalogCache = null;
    });
  }, []);
  return catalog;
}

/** 订阅本凭证的更新：收到推送就重新拉取自己的视图。 */
export function useStream(roomId: string, token: string, onUpdate: () => void): void {
  const ref = useRef(onUpdate);
  ref.current = onUpdate;
  useEffect(() => {
    const es = new EventSource(streamUrl(roomId, token));
    es.addEventListener('update', () => ref.current());
    es.onopen = () => ref.current();
    const timer = setInterval(() => ref.current(), 20_000);
    const onFocus = () => ref.current();
    window.addEventListener('focus', onFocus);
    return () => {
      es.close();
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [roomId, token]);
}

export function useView(roomId: string, token: string) {
  const [data, setData] = useState<ViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const dirty = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) {
      dirty.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        dirty.current = false;
        const v = await api.view(roomId, token);
        setData(v);
        setError(null);
      } while (dirty.current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [roomId, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useStream(roomId, token, () => void refresh());
  return { data, error, refresh };
}

export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
