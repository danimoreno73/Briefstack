import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { langFromLocale, type Lang } from '../i18n/index.js';
import { uiMessages } from '../i18n/ui.js';
import { ApiError, api, takeToken } from './api.js';
import { NewProjectPage } from './creation.js';
import { AppCtx, type AppContext } from './hooks.js';
import { LibraryView } from './library.js';
import { ProjectView, ProjectsView } from './projects.js';
import { parseRoute, routeHash, type Route } from './route.js';
import { SettingsPage } from './settings.js';
import { readStoredLang, storeLang } from './storedLang.js';
import type { SettingsView } from './types.js';
import { UsageView } from './usage.js';

type Gate = 'connecting' | 'ready' | 'noToken' | 'rejected' | 'unreachable';

const NAV: { page: Route['page']; route: Route; label: 'navProjects' | 'navNew' | 'navLibrary' | 'navUsage' | 'navSettings' }[] = [
  { page: 'projects', route: { page: 'projects' }, label: 'navProjects' },
  { page: 'new', route: { page: 'new', id: undefined }, label: 'navNew' },
  { page: 'library', route: { page: 'library', section: undefined, name: undefined }, label: 'navLibrary' },
  { page: 'usage', route: { page: 'usage' }, label: 'navUsage' },
  { page: 'settings', route: { page: 'settings' }, label: 'navSettings' },
];

function useRoute(): Route {
  // The token has already been taken out of the address by now (see the bottom of this file).
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'projects':
      return <ProjectsView />;
    case 'project':
      return <ProjectView key={route.slug} slug={route.slug} />;
    case 'new':
      return <NewProjectPage id={route.id} />;
    case 'library':
      return <LibraryView section={route.section} name={route.name} />;
    case 'usage':
      return <UsageView />;
    case 'settings':
      return <SettingsPage />;
  }
}

function App({ initialLang, token }: { initialLang: Lang; token: string | undefined }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [gate, setGate] = useState<Gate>(token === undefined ? 'noToken' : 'connecting');
  const route = useRoute();
  const t = uiMessages[lang];

  useEffect(() => {
    if (token === undefined) return;
    // The saved language wins over the browser's once the server has answered.
    api<SettingsView>(token, 'GET', '/api/settings').then(
      (settings) => {
        storeLang(settings.lang);
        setLang(settings.lang);
        setGate('ready');
      },
      (error: unknown) => setGate(error instanceof ApiError ? 'rejected' : 'unreachable'),
    );
  }, [token]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Whether a creation is running, so the menu can say so wherever the user is. Checked on every move and every few seconds.
  const [activeCreation, setActiveCreation] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (gate !== 'ready' || token === undefined) return;
    let stopped = false;
    const check = () => {
      api<{ creations: { id: string; status: string }[] }>(token, 'GET', '/api/creations').then(
        (result) => {
          if (!stopped) setActiveCreation(result.creations.find((creation) => creation.status !== 'finished')?.id);
        },
        () => undefined,
      );
    };
    check();
    const timer = setInterval(check, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [gate, token, route]);

  const context = useMemo<AppContext | undefined>(
    () =>
      token === undefined
        ? undefined
        : {
            lang,
            t,
            token,
            // Kept at once, not in an effect, so a reload right after saving already sees it.
            setLang: (next: Lang) => {
              storeLang(next);
              setLang(next);
            },
          },
    [lang, t, token],
  );

  if (gate !== 'ready' || context === undefined) {
    return (
      <main>
        <h1>{t.title}</h1>
        <p role="status">{t[gate === 'ready' ? 'connecting' : gate]}</p>
      </main>
    );
  }
  return (
    <AppCtx.Provider value={context}>
      <header>
        <strong>{t.title}</strong>
        <nav aria-label={t.navLabel}>
          {NAV.map((item) => (
            <a key={item.page} href={routeHash(item.route)} aria-current={route.page === item.page || (item.page === 'projects' && route.page === 'project') ? 'page' : undefined}>
              {t[item.label]}
              {item.page === 'new' && activeCreation !== undefined && (
                <span class="dot" role="img" aria-label={t.creationInProgress} title={t.creationInProgress}>
                  {' '}
                  ●
                </span>
              )}
            </a>
          ))}
        </nav>
      </header>
      <main>
        <Page route={route} />
      </main>
    </AppCtx.Provider>
  );
}

// 1. Read the token from the address and keep it for this tab; 2. clean the
// address (`history.replaceState`); only then 3. start the router and render.
const token = takeToken();
const root = document.getElementById('app');
if (root !== null) render(<App initialLang={readStoredLang() ?? langFromLocale(navigator.language) ?? 'en'} token={token} />, root);
