import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { langFromLocale, type Lang } from '../i18n/index.js';
import { uiMessages } from '../i18n/ui.js';
import { ApiError, api, takeToken } from './api.js';

interface Health {
  ok: boolean;
  version: string;
}

type Status = { kind: 'connecting' } | { kind: 'connected'; version: string } | { kind: 'noToken' | 'rejected' | 'unreachable' };

function App({ lang, token }: { lang: Lang; token: string | undefined }) {
  const t = uiMessages[lang];
  const [status, setStatus] = useState<Status>(token === undefined ? { kind: 'noToken' } : { kind: 'connecting' });

  useEffect(() => {
    if (token === undefined) return;
    api<Health>(token, 'GET', '/api/health')
      .then((health) => setStatus({ kind: 'connected', version: health.version }))
      .catch((error: unknown) => setStatus({ kind: error instanceof ApiError ? 'rejected' : 'unreachable' }));
  }, [token]);

  let text: string;
  switch (status.kind) {
    case 'connecting':
      text = t.connecting;
      break;
    case 'connected':
      text = t.connected(status.version);
      break;
    default:
      text = t[status.kind];
  }
  return (
    <main>
      <h1>{t.title}</h1>
      <p role="status">{text}</p>
    </main>
  );
}

const lang: Lang = langFromLocale(navigator.language) ?? 'en';
document.documentElement.lang = lang;
const root = document.getElementById('app');
if (root !== null) render(<App lang={lang} token={takeToken()} />, root);
