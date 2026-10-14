import type { IncomingMessage, ServerResponse } from 'node:http';

export type RouteParams = Readonly<Record<string, string>>;

export type Handler = (req: IncomingMessage, res: ServerResponse, params: RouteParams) => Promise<void> | void;

/** A route: `METHOD /api/path`, where a `:name` segment matches one path segment. */
export type RouteTable = readonly (readonly [string, Handler])[];

export interface RouteMatch {
  handler: Handler;
  params: RouteParams;
}

interface PatternRoute {
  method: string;
  segments: string[];
  handler: Handler;
}

/**
 * Matches a method and path to a handler. Routes without parameters match
 * exactly; `:name` segments match one non-empty, decoded segment. A wrong
 * method is no match (the server answers 404).
 */
export function createRouter(table: RouteTable): (method: string, pathname: string) => RouteMatch | undefined {
  const exact = new Map<string, Handler>();
  const patterns: PatternRoute[] = [];
  for (const [key, handler] of table) {
    const [method = '', pattern = ''] = key.split(' ');
    if (pattern.includes('/:')) patterns.push({ method, segments: pattern.split('/'), handler });
    else exact.set(key, handler);
  }

  return (method, pathname) => {
    const handler = exact.get(`${method} ${pathname}`);
    if (handler !== undefined) return { handler, params: {} };
    const parts = pathname.split('/');
    for (const route of patterns) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (const [index, segment] of route.segments.entries()) {
        const part = parts[index] as string;
        if (segment.startsWith(':')) {
          let decoded: string;
          try {
            decoded = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
          if (decoded === '') {
            ok = false;
            break;
          }
          params[segment.slice(1)] = decoded;
        } else if (segment !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return undefined;
  };
}
