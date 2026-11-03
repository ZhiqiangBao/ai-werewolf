import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog, ViewResponse } from '@werewolf/protocol';
import { api, streamUrl } from './api';
import { scopedCallback, ViewLoader } from './view-loader';

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
  const scope = useMemo(() => ({}), [roomId, token]);
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => {
    let active = true;
    const es = new EventSource(streamUrl(roomId, token));
    const update = scopedCallback(() => active && currentScope.current === scope, () => ref.current());
    es.addEventListener('update', update);
    es.onopen = update;
    const timer = setInterval(update, 20_000);
    const onFocus = update;
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      es.close();
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [roomId, token, scope]);
}

export function useView(roomId: string, token: string) {
  const [snapshot, setSnapshot] = useState<{ loader: ViewLoader<ViewResponse>; data: ViewResponse | null; error: string | null } | null>(null);
  const current = useRef<ViewLoader<ViewResponse> | null>(null);
  const loader = useMemo(() => {
    const own: ViewLoader<ViewResponse> = new ViewLoader(
      () => api.view(roomId, token),
      (data, error) => setSnapshot((previous) => ({ loader: own, data: data ?? (previous?.loader === own ? previous.data : null), error })),
      () => current.current === own,
    );
    return own;
  }, [roomId, token]);
  current.current = loader;
  const refresh = useCallback(() => loader.refresh(), [loader]);

  useEffect(() => {
    loader.activate();
    void refresh();
    return () => loader.deactivate();
  }, [loader, refresh]);
  useStream(roomId, token, () => void refresh());
  return { data: snapshot?.loader === loader ? snapshot.data : null, error: snapshot?.loader === loader ? snapshot.error : null, refresh };
}

export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
