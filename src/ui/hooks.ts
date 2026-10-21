import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import type { Lang } from '../i18n/index.js';
import { uiMessages } from '../i18n/ui.js';
import { api } from './api.js';

/** What every view needs: the strings, the language, and the way to call the server. */
export interface AppContext {
  lang: Lang;
  t: (typeof uiMessages)['en'];
  token: string;
  setLang(lang: Lang): void;
}

export const AppCtx = createContext<AppContext | undefined>(undefined);

export function useApp(): AppContext {
  const context = useContext(AppCtx);
  if (context === undefined) throw new Error('AppCtx is missing');
  return context;
}

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload(): void;
}

/** GETs `path` and again when it changes or `reload()` is called. A stale answer is dropped. */
export function useLoad<T>(path: string): Loaded<T> {
  const { token } = useApp();
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let current = true;
    setState((previous) => ({ ...previous, loading: true, error: undefined }));
    api<T>(token, 'GET', path).then(
      (data) => current && setState({ data, error: undefined, loading: false }),
      (error: unknown) => current && setState({ data: undefined, error, loading: false }),
    );
    return () => {
      current = false;
    };
  }, [token, path, epoch]);

  const reload = useCallback(() => setEpoch((value) => value + 1), []);
  return { ...state, reload };
}

/** The tab's title: what the page is about, then the app's name (audit M2). Without a subject, just the name. */
export function useDocumentTitle(subject: string | undefined): void {
  useEffect(() => {
    const text = subject?.replace(/\s+/g, ' ').trim();
    document.title = text === undefined || text === '' ? 'briefstack' : `${text.length > 60 ? `${text.slice(0, 60)}…` : text} · briefstack`;
  }, [subject]);
}

/** Calls a write route. */
export function useSend(): <T>(method: string, path: string, body?: unknown) => Promise<T> {
  const { token } = useApp();
  return useCallback(<T>(method: string, path: string, body?: unknown) => api<T>(token, method, path, body), [token]);
}
