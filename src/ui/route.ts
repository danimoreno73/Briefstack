/** The address bar's fragment (`#/library/profile/style`) as a route, and back. */

export type Route =
  | { page: 'projects' }
  | { page: 'new'; id: string | undefined }
  | { page: 'project'; slug: string }
  /** A creation session's agent panel, rebuilt from its recorded events. */
  | { page: 'session'; id: string }
  | { page: 'library'; section: string | undefined; name: string | undefined }
  | { page: 'usage' }
  | { page: 'settings' };

export const DEFAULT_ROUTE: Route = { page: 'projects' };

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/** Unknown or malformed hashes fall back to the projects page. */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter((part) => part !== '');
  const decoded = parts.map(decode);
  if (decoded.includes(undefined)) return DEFAULT_ROUTE;
  const [page, first, ...rest] = decoded as string[];
  switch (page) {
    case 'projects':
      return first === undefined ? DEFAULT_ROUTE : { page: 'project', slug: first };
    case 'library':
      return { page: 'library', section: first, name: rest.length === 0 ? undefined : rest.join('/') };
    case 'new':
      return { page: 'new', id: first };
    case 'sessions':
      return first === undefined ? DEFAULT_ROUTE : { page: 'session', id: first };
    case 'usage':
      return { page: 'usage' };
    case 'settings':
      return { page: 'settings' };
    default:
      return DEFAULT_ROUTE;
  }
}

const enc = encodeURIComponent;

export function routeHash(route: Route): string {
  switch (route.page) {
    case 'projects':
      return '#/projects';
    case 'project':
      return `#/projects/${enc(route.slug)}`;
    case 'new':
      return route.id === undefined ? '#/new' : `#/new/${enc(route.id)}`;
    case 'session':
      return `#/sessions/${enc(route.id)}`;
    case 'library': {
      if (route.section === undefined) return '#/library';
      const name = route.name === undefined ? '' : `/${route.name.split('/').map(enc).join('/')}`;
      return `#/library/${enc(route.section)}${name}`;
    }
    case 'usage':
      return '#/usage';
    case 'settings':
      return '#/settings';
  }
}
