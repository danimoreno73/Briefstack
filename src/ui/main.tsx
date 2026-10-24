import { render, type ComponentChildren, type FunctionComponent } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { isLang, langFromLocale, type Lang } from '../i18n/index.js';
import { uiMessages } from '../i18n/ui.js';
import { ApiError, CREATIONS_CHANGED_EVENT, TOKEN_REJECTED_EVENT, api, takeToken } from './api.js';
import { NewProjectPage } from './creation.js';
import { CreationsPage } from './creations.js';
import { ChatDrawer, ChatPage } from './chat.js';
import { ImprovePage } from './improve.js';
import { AppCtx, useApp, useSend, type AppContext } from './hooks.js';
import {
  IconChat,
  IconClose,
  IconCreations,
  IconGlobe,
  IconImprove,
  IconLibrary,
  IconMenu,
  IconNew,
  IconProjects,
  IconSettings,
  IconSkills,
  IconUsage,
} from './icons.js';
import { SkillsPage } from './skills.js';
import { LibraryView } from './library.js';
import { SessionPanelPage } from './panel.js';
import { ProjectView, ProjectsView } from './projects.js';
import { parseRoute, routeHash, type Route } from './route.js';
import { SettingsPage } from './settings.js';
import { readStoredLang, storeLang } from './storedLang.js';
import { applyTheme, readStoredTheme } from './theme.js';
import { ThemeSwitch } from './themeSwitch.js';
import type { SettingsView } from './types.js';
import { UsageView } from './usage.js';

type Gate = 'connecting' | 'ready' | 'noToken' | 'rejected' | 'unreachable' | 'restarted';

type NavLabel = 'navProjects' | 'navNew' | 'navCreations' | 'navChat' | 'navImprove' | 'navLibrary' | 'navSkills' | 'navUsage' | 'navSettings';

// The order of the design's rail (docs/diseno).
const NAV: { page: Route['page']; route: Route; label: NavLabel; icon: FunctionComponent }[] = [
  { page: 'projects', route: { page: 'projects' }, label: 'navProjects', icon: IconProjects },
  { page: 'new', route: { page: 'new', id: undefined }, label: 'navNew', icon: IconNew },
  { page: 'creations', route: { page: 'creations' }, label: 'navCreations', icon: IconCreations },
  { page: 'library', route: { page: 'library', section: undefined, name: undefined }, label: 'navLibrary', icon: IconLibrary },
  { page: 'skills', route: { page: 'skills', name: undefined }, label: 'navSkills', icon: IconSkills },
  { page: 'improve', route: { page: 'improve', id: undefined }, label: 'navImprove', icon: IconImprove },
  { page: 'chat', route: { page: 'chat', thread: undefined }, label: 'navChat', icon: IconChat },
  { page: 'usage', route: { page: 'usage' }, label: 'navUsage', icon: IconUsage },
  { page: 'settings', route: { page: 'settings' }, label: 'navSettings', icon: IconSettings },
];

/** The menu item a route belongs to: a project or a past session under Projects, a running creation under Creations. */
function navPage(route: Route): Route['page'] {
  if (route.page === 'project' || route.page === 'session') return 'projects';
  if (route.page === 'new' && route.id !== undefined) return 'creations';
  return route.page;
}

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
    case 'skills':
      return <SkillsPage name={route.name} />;
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

  // How many creations are running and how many wait for the user, so the menu can say so wherever the
  // user is. Checked on every move and every few seconds.
  const [activeCreations, setActiveCreations] = useState({ running: 0, waiting: 0 });
  useEffect(() => {
    if (gate !== 'ready' || token === undefined) return;
    let stopped = false;
    const check = () => {
      api<{ creations: { id: string; status: string }[] }>(token, 'GET', '/api/creations').then(
        (result) => {
          if (stopped) return;
          const active = result.creations.filter((creation) => creation.status !== 'finished');
          setActiveCreations({ running: active.length, waiting: active.filter((creation) => creation.status === 'waiting').length });
        },
        () => undefined,
      );
    };
    check();
    const timer = setInterval(check, 4000);
    // A creation page says at once when its creation changes status, so the count does not lag behind.
    window.addEventListener(CREATIONS_CHANGED_EVENT, check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener(CREATIONS_CHANGED_EVENT, check);
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
    // Nothing to do here but read: a restarted tab has no button, the new token is only in the terminal.
    return (
      <main class="gate">
        <span class="brand-row" translate={false}>
          <span class="logo" aria-hidden="true">
            b
          </span>
          <span class="brand-name">briefstack</span>
        </span>
        {shown === 'connecting' ? (
          <section class="card" aria-busy="true" aria-labelledby="gate-title">
            <h1 class="t-2" id="gate-title">
              {t.gateTitle(shown)}
            </h1>
            <p role="status" class="muted">
              {t[shown]}
            </p>
            <span class="loader" aria-hidden="true">
              <span />
            </span>
          </section>
        ) : (
          <section class="dec" role="alertdialog" aria-labelledby="gate-title">
            <h1 class="gate-title" id="gate-title">
              {t.gateTitle(shown)}
            </h1>
            <p role="status">{t[shown]}</p>
          </section>
        )}
      </main>
    );
  }
  return (
    <AppCtx.Provider value={context}>
      <Shell route={route} activeCreations={activeCreations}>
        <Page route={route} />
      </Shell>
    </AppCtx.Provider>
  );
}

/** The rail, the phone's top bar, the page, and the chat drawer over any page but the chat's own. */
function Shell({ route, activeCreations, children }: { route: Route; activeCreations: { running: number; waiting: number }; children: ComponentChildren }) {
  const { t } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Where focus goes back to when the drawer closes: whatever opened it.
  const opener = useRef<HTMLElement | null>(null);
  const chatAllowed = route.page !== 'chat';

  // A move closes the phone's menu and, onto the chat page, the drawer.
  useEffect(() => {
    setMenuOpen(false);
    if (!chatAllowed) setChatOpen(false);
  }, [route, chatAllowed]);

  // The phone's menu takes focus when it opens (its close button) and gives it back to the menu button.
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuWasOpen = useRef(false);
  useEffect(() => {
    if (menuOpen) document.querySelector<HTMLElement>('#rail .brand button')?.focus();
    else if (menuWasOpen.current) menuButton.current?.focus();
    menuWasOpen.current = menuOpen;
  }, [menuOpen]);

  const openChat = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenuOpen(false);
    setChatOpen(true);
  };
  const closeChat = () => {
    setChatOpen(false);
    const back = opener.current;
    setTimeout(() => back?.focus(), 0);
  };

  // Ctrl J opens the drawer from any page (Cmd J on a Mac), and closes it again.
  useEffect(() => {
    if (!chatAllowed) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'j' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (chatOpen) closeChat();
      else openChat();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const { running, waiting } = activeCreations;
  const creationsLabel = waiting > 0 ? `${t.creationsRunning(running)}, ${t.creationsWaiting(waiting)}` : t.creationsRunning(running);

  return (
    <div class="app">
      {/* First on the page, shown when focused (audit M3). The address keeps its route: focus moves, the hash does not. */}
      <a
        class="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        {t.skipToContent}
      </a>
      <nav
        class={menuOpen ? 'rail rail-open' : 'rail'}
        id="rail"
        aria-label={t.navLabel}
        onKeyDown={(event) => {
          if (menuOpen && event.key === 'Escape') setMenuOpen(false);
        }}
      >
        <div class="brand">
          <a class="brand-row" href={routeHash({ page: 'projects' })} translate={false}>
            <span class="logo" aria-hidden="true">
              b
            </span>
            <span class="brand-text">
              <span class="brand-name">briefstack</span>
              <span class="brand-host">
                {window.location.host} · {t.brandLocal}
              </span>
            </span>
          </a>
          <button type="button" class="btn btn-ghost btn-icon m-only" aria-label={t.menuClose} onClick={() => setMenuOpen(false)}>
            <IconClose />
          </button>
        </div>
        <ul class="nav">
          {NAV.map((item) => (
            <li key={item.page}>
              <a href={routeHash(item.route)} aria-current={navPage(route) === item.page ? 'page' : undefined}>
                <item.icon />
                {t[item.label]}
                {item.page === 'creations' && running > 0 && (
                  // Cream when one waits for the user: the colour of what expects an answer.
                  <span class={waiting > 0 ? 'badge badge-dec' : 'badge'} role="img" aria-label={creationsLabel} title={creationsLabel}>
                    {running}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
        <div class="rail-foot">
          <div class="row">
            <ThemeSwitch />
            <LangSwitch />
          </div>
          {chatAllowed && (
            <button type="button" class="btn btn-ghost btn-sm rail-chat" aria-expanded={chatOpen} aria-controls="chat-drawer" onClick={openChat} hidden={chatOpen}>
              <span>{t.chatOpen}</span>
              <span class="kbd" aria-hidden="true">
                {t.chatShortcut}
              </span>
            </button>
          )}
        </div>
      </nav>
      {menuOpen && <div class="rail-scrim m-only" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
      <main class="main" id="main" tabIndex={-1}>
        <div class="topbar">
          <a class="brand-row" href={routeHash({ page: 'projects' })} translate={false}>
            <span class="logo" aria-hidden="true">
              b
            </span>
            <span class="brand-name">briefstack</span>
          </a>
          <div class="btn-row">
            {chatAllowed && !chatOpen && (
              <button type="button" class="btn btn-ghost btn-icon" aria-label={t.chatOpen} aria-controls="chat-drawer" onClick={openChat}>
                <IconChat />
              </button>
            )}
            <button
              ref={menuButton}
              type="button"
              class="btn btn-ghost btn-icon"
              aria-label={t.menuOpen}
              aria-expanded={menuOpen}
              aria-controls="rail"
              onClick={() => setMenuOpen(true)}
            >
              <IconMenu />
            </button>
          </div>
        </div>
        {children}
      </main>
      {chatAllowed && chatOpen && <ChatDrawer onClose={closeChat} />}
    </div>
  );
}

/** English or Spanish, saved in the settings like the Settings page does. */
function LangSwitch() {
  const { t, lang, setLang } = useApp();
  const send = useSend();
  const [busy, setBusy] = useState(false);
  const next: Lang = lang === 'es' ? 'en' : 'es';
  const change = async () => {
    setBusy(true);
    try {
      const saved = await send<SettingsView>('PUT', '/api/settings', { lang: next });
      if (isLang(saved.lang)) setLang(saved.lang);
    } catch {
      // Not saved: the language stays as it is, and Settings shows why if the user goes there.
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" class="btn btn-secondary btn-sm" aria-label={t.langSwitch(lang)} disabled={busy} onClick={() => void change()}>
      <IconGlobe />
      {t.langShort(lang)}
    </button>
  );
}

// 1. Read the token from the address and keep it for this tab; 2. clean the
// address (`history.replaceState`); only then 3. start the router and render.
const token = takeToken();
applyTheme(readStoredTheme());
const root = document.getElementById('app');
if (root !== null) render(<App initialLang={readStoredLang() ?? langFromLocale(navigator.language) ?? 'en'} token={token} />, root);
