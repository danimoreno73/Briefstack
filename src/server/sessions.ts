import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Device sessions of server mode (phase 12; PLAN-phase-12 §1, 4 and 5). A
 * correct access secret makes a session: a random token sent once, in an
 * `HttpOnly; Secure; SameSite=Strict` cookie; the server keeps only its
 * SHA-256, with a device label and two times, in one file under the home.
 * The token is never logged, never in a URL or an answer body.
 */

/** `__Host-`: the browser keeps it only with `Secure`, `Path=/` and no `Domain`. */
export const SESSION_COOKIE = '__Host-briefstack-session';
/** The longest a browser keeps a cookie (400 days). */
export const SESSION_MAX_AGE_S = 400 * 24 * 60 * 60;
/** Failed sign-ins within `SIGN_IN_WINDOW_MS` that lock sign-in for `SIGN_IN_LOCK_MS`. */
export const SIGN_IN_LIMIT = 5;
export const SIGN_IN_WINDOW_MS = 15 * 60_000;
export const SIGN_IN_LOCK_MS = 15 * 60_000;
/** A device's last use is written at most this often. */
const LAST_SEEN_EVERY_MS = 60_000;
const MAX_LABEL = 120;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface DeviceRecord {
  /** A public id for the devices list and revoke: not the token. */
  id: string;
  /** SHA-256 of the token, hex. */
  digest: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

/** What the page sees of a device: never its digest. */
export interface DeviceView {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

const digestOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** A `User-Agent` as a short label: control characters out, at most 120 characters. */
export function deviceLabel(userAgent: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const text = (userAgent ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Empty when the browser sent none: the page names it in the user's language (review of M2, 3).
  return text.slice(0, MAX_LABEL);
}

/** The session token in a `Cookie` header, when it has the shape of one. */
export function sessionToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_SHAPE.test(value) ? value : undefined;
  }
  return undefined;
}

/** The `Set-Cookie` value that gives the browser its session. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}

/** The `Set-Cookie` value that removes it. */
export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

interface SessionsFile {
  v: 1;
  devices: DeviceRecord[];
}

const isRecord = (value: unknown): value is DeviceRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return ['id', 'digest', 'label', 'createdAt', 'lastSeenAt'].every((key) => typeof r[key] === 'string') && /^[0-9a-f]{64}$/.test(r.digest as string);
};

export interface DeviceSessionsOptions {
  file: string;
  now?: () => Date;
  /** Called after devices were signed out (revoke, revoke all, sign-out), with their ids, so their open streams end. */
  onRevoked?: (ids: readonly string[]) => void;
  /** Called when the file exists but does not read back: nobody is signed in, and the server says so in its log. */
  onUnreadable?: () => void;
}

/**
 * The signed-in devices, in `<home>/server/sessions.json`. Every change
 * goes through one chain, and the file is written through a temp file and
 * a rename, readable by its owner only where that applies.
 */
export class DeviceSessions {
  private devices: DeviceRecord[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly now: () => Date,
    private readonly onRevoked: (ids: readonly string[]) => void,
  ) {}

  /**
   * Opens the file; a missing one is an empty list (nobody is signed in),
   * and so is one that does not read back, with `onUnreadable` called.
   * Expired devices are dropped.
   */
  static async open(options: DeviceSessionsOptions): Promise<DeviceSessions> {
    const sessions = new DeviceSessions(options.file, options.now ?? (() => new Date()), options.onRevoked ?? (() => undefined));
    let text: string | undefined;
    try {
      text = await readFile(options.file, 'utf8');
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text) as Partial<SessionsFile>;
        sessions.devices = Array.isArray(parsed.devices) ? parsed.devices.filter(isRecord).filter((device) => !sessions.expired(device)) : [];
      } catch {
        sessions.devices = [];
        options.onUnreadable?.();
      }
    }
    return sessions;
  }

  /**
   * Not used for longer than a cookie lives: the server forgets it, so a
   * copied token does not outlive the browser's cookie (review of M2, 5).
   */
  private expired(device: DeviceRecord): boolean {
    const last = Date.parse(device.lastSeenAt);
    return !Number.isFinite(last) || this.now().getTime() - last > SESSION_MAX_AGE_S * 1000;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.chain.then(action);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Writes `devices` and only then keeps them, so a failed write changes nothing (review of M2, 4). */
  private async commit(devices: DeviceRecord[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body: SessionsFile = { v: 1, devices };
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, this.file);
    this.devices = devices;
  }

  /** A new session for a device: the token, given once, and its record. */
  signIn(userAgent: string | undefined): Promise<{ token: string; device: DeviceRecord }> {
    return this.serial(async () => {
      const token = randomBytes(32).toString('base64url');
      const at = this.now().toISOString();
      const device: DeviceRecord = { id: randomBytes(12).toString('base64url'), digest: digestOf(token).toString('hex'), label: deviceLabel(userAgent), createdAt: at, lastSeenAt: at };
      await this.commit([...this.devices.filter((other) => !this.expired(other)), device]);
      return { token, device };
    });
  }

  /**
   * The device a token belongs to: every stored digest is compared in
   * constant time (all are 32 bytes). Its last use is written now and then.
   */
  async find(token: string | undefined): Promise<DeviceRecord | undefined> {
    if (token === undefined || !TOKEN_SHAPE.test(token)) return undefined;
    const given = digestOf(token);
    let found: DeviceRecord | undefined;
    for (const device of this.devices) {
      if (timingSafeEqual(given, Buffer.from(device.digest, 'hex'))) found = device;
    }
    if (found === undefined || this.expired(found)) return undefined;
    const now = this.now();
    if (now.getTime() - Date.parse(found.lastSeenAt) >= LAST_SEEN_EVERY_MS) {
      const id = found.id;
      await this.serial(() => this.commit(this.devices.map((device) => (device.id === id ? { ...device, lastSeenAt: now.toISOString() } : device)))).catch(() => undefined);
    }
    return this.devices.find((device) => device.id === found?.id);
  }

  list(currentId: string | undefined): DeviceView[] {
    return this.devices
      .filter((device) => !this.expired(device))
      .map((device) => ({ id: device.id, label: device.label, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, current: device.id === currentId }));
  }

  /** Signs one device out; `false` when there was none with that id. Its open streams end. */
  async revoke(id: string): Promise<boolean> {
    const done = await this.serial(async () => {
      const next = this.devices.filter((device) => device.id !== id);
      if (next.length === this.devices.length) return false;
      await this.commit(next);
      return true;
    });
    if (done) this.onRevoked([id]);
    return done;
  }

  /** Signs every device out, this one included, and ends their open streams. */
  async revokeAll(): Promise<void> {
    const ids = await this.serial(async () => {
      const before = this.devices.map((device) => device.id);
      await this.commit([]);
      return before;
    });
    this.onRevoked(ids);
  }
}

/**
 * The limit on failed sign-ins: one counter for the whole server, in
 * memory. `SIGN_IN_LIMIT` failures within `SIGN_IN_WINDOW_MS` lock every
 * sign-in, the right secret included, for `SIGN_IN_LOCK_MS`.
 */
export class SignInLimiter {
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Seconds left of a lock, or `undefined` when sign-in is open. */
  locked(): number | undefined {
    const now = this.now().getTime();
    if (now >= this.lockedUntil) return undefined;
    return Math.ceil((this.lockedUntil - now) / 1000);
  }

  fail(): void {
    const now = this.now().getTime();
    this.failures = [...this.failures.filter((at) => now - at < SIGN_IN_WINDOW_MS), now];
    if (this.failures.length >= SIGN_IN_LIMIT) {
      this.lockedUntil = now + SIGN_IN_LOCK_MS;
      this.failures = [];
    }
  }

  succeed(): void {
    this.failures = [];
  }
}
