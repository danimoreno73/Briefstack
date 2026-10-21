import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { langFromLocale, type Lang } from '../i18n/index.js';
import { uiMessages } from '../i18n/ui.js';
import { ApiError, TOKEN_REJECTED_EVENT, api, takeToken } from './api.js';
import { NewProjectPage } from './creation.js';
import { CreationsPage } from './creations.js';
import { ChatDrawer, ChatPage } from './chat.js';
import { ImprovePage } from './improve.js';
import { AppCtx, useApp, type AppContext } from './hooks.js';
import { LibraryView } from './library.js';
import { SessionPanelPage } from './panel.js';
import { ProjectView, ProjectsView } from './projects.js';
import { parseRoute, routeHash, type Route } from './route.js';
import { SettingsPage } from './settings.js';
import { readStoredLang, storeLang } from './storedLang.js';
import { THEMES, applyTheme, readStoredTheme, type Theme } from './theme.js';
import type { SettingsView } from './types.js';
import { UsageView } from './usage.js';

type Gate = 'connecting' | 'ready' | 'noToken' | 'rejected' | 'unreachable' | 'restarted';

const NAV: { page: Route['page']; route: Route; label: 'navProjects' | 'navNew' | 'navCreations' | 'navChat' | 'navImprove' | 'navLibrary' | 'navUsage' | 'navSettings' }[] = [
  { page: 'projects', route: { page: 'projects' }, label: 'navProjects' },
  { page: 'new', route: { page: 'new', id: undefined }, label: 'navNew' },
  { page: 'creations', route: { page: 'creations' }, label: 'navCreations' },
  { page: 'chat', route: { page: 'chat', thread: undefined }, label: 'navChat' },
  { page: 'improve', route: { page: 'improve', id: undefined }, label: 'navImprove' },
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
    case 'creations':
      return <CreationsPage />;
    case 'chat':
      return <ChatPage thread={route.thread} />;
    case 'session':
      return <SessionPanelPage key={route.id} id={route.id} />;
    case 'library':
      return <LibraryView section={route.section} name={route.name} />;
    case 'usage':
      return <UsageView />;
    case 'settings':
      return <SettingsPage />;
    case 'improve':
      return <ImprovePage id={route.id} />;
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
      (error: unknown) =>
        setGate(error instanceof ApiError ? (error.code === 'web.rejected.token' ? 'restarted' : 'rejected') : 'unreachable'),
    );
  }, [token]);

  // A tab left open across a restart has the old token: say so, instead of an error with a retry that cannot work.
  useEffect(() => {
    const restarted = () => setGate('restarted');
    window.addEventListener(TOKEN_REJECTED_EVENT, restarted);
    return () => window.removeEventListener(TOKEN_REJECTED_EVENT, restarted);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // How many creations are running, so the menu can say so wherever the user is. Checked on every move and every few seconds.
  const [activeCreations, setActiveCreations] = useState(0);
  useEffect(() => {
    if (gate !== 'ready' || token === undefined) return;
    let stopped = false;
    const check = () => {
      api<{ creations: { id: string; status: string }[] }>(token, 'GET', '/api/creations').then(
        (result) => {
          if (!stopped) setActiveCreations(result.creations.filter((creation) => creation.status !== 'finished').length);
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
    const shown = gate === 'ready' ? 'connecting' : gate;
    return (
      <main class="gate">
        <strong class="logo" translate={false}>
          <span class="logo-brief">brief</span>
          <span class="logo-stack">stack</span>
        </strong>
        <div class={shown === 'connecting' ? 'panel' : 'panel attention'}>
          <h1>{t.gateTitle(shown)}</h1>
          <p role="status">{t[shown]}</p>
        </div>
      </main>
    );
  }
  return (
    <AppCtx.Provider value={context}>
      <header>
        <strong class="logo" translate={false}>
          <span class="logo-brief">brief</span>
          <span class="logo-stack">stack</span>
        </strong>
        <nav aria-label={t.navLabel}>
          {NAV.map((item) => (
            <a key={item.page} href={routeHash(item.route)} aria-current={route.page === item.page || (item.page === 'projects' && (route.page === 'project' || route.page === 'session')) ? 'page' : undefined}>
              {t[item.label]}
              {item.page === 'creations' && activeCreations > 0 && (
                <span class="dot" role="img" aria-label={t.creationInProgress} title={t.creationInProgress}>
                  {' '}
                  ● {activeCreations}
                </span>
              )}
            </a>
          ))}
        </nav>
        <div class="shell-tools">
          <ThemeSwitch />
          {/* The compact chat on every page but the chat's own. */}
          {route.page !== 'chat' && <ChatDrawer />}
        </div>
      </header>
      <main>
        <Page route={route} />
      </main>
    </AppCtx.Provider>
  );
}

/** System, light or dark; kept per browser. */
function ThemeSwitch() {
  const { t } = useApp();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  return (
    <label class="theme-switch">
      <span class="theme-label">{t.themeLabel}</span>
      <select
        value={theme}
        onChange={(event) => {
          const next = event.currentTarget.value as Theme;
          setTheme(next);
          applyTheme(next, true);
        }}
      >
        {THEMES.map((value) => (
          <option key={value} value={value}>
            {t.themeName(value)}
          </option>
        ))}
      </select>
    </label>
  );
}

// 1. Read the token from the address and keep it for this tab; 2. clean the
// address (`history.replaceState`); only then 3. start the router and render.
const token = takeToken();
applyTheme(readStoredTheme());
const root = document.getElementById('app');
if (root !== null) render(<App initialLang={readStoredLang() ?? langFromLocale(navigator.language) ?? 'en'} token={token} />, root);
