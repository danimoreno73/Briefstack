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
  return text === '' ? 'Unknown device' : text.slice(0, MAX_LABEL);
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
  ) {}

  /** Opens the file; a missing or unreadable one is an empty list (nobody is signed in). */
  static async open(options: { file: string; now?: () => Date }): Promise<DeviceSessions> {
    const sessions = new DeviceSessions(options.file, options.now ?? (() => new Date()));
    try {
      const parsed = JSON.parse(await readFile(options.file, 'utf8')) as Partial<SessionsFile>;
      sessions.devices = Array.isArray(parsed.devices) ? parsed.devices.filter(isRecord) : [];
    } catch {
      sessions.devices = [];
    }
    return sessions;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.chain.then(action);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body: SessionsFile = { v: 1, devices: this.devices };
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, this.file);
  }

  /** A new session for a device: the token, given once, and its record. */
  signIn(userAgent: string | undefined): Promise<{ token: string; device: DeviceRecord }> {
    return this.serial(async () => {
      const token = randomBytes(32).toString('base64url');
      const at = this.now().toISOString();
      const device: DeviceRecord = { id: randomBytes(12).toString('base64url'), digest: digestOf(token).toString('hex'), label: deviceLabel(userAgent), createdAt: at, lastSeenAt: at };
      this.devices = [...this.devices, device];
      await this.save();
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
    if (found === undefined) return undefined;
    const now = this.now();
    if (now.getTime() - Date.parse(found.lastSeenAt) >= LAST_SEEN_EVERY_MS) {
      const id = found.id;
      await this.serial(async () => {
        this.devices = this.devices.map((device) => (device.id === id ? { ...device, lastSeenAt: now.toISOString() } : device));
        await this.save();
      }).catch(() => undefined);
    }
    return this.devices.find((device) => device.id === found?.id);
  }

  list(currentId: string | undefined): DeviceView[] {
    return this.devices.map((device) => ({ id: device.id, label: device.label, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, current: device.id === currentId }));
  }

  /** Signs one device out; `false` when there was none with that id. */
  revoke(id: string): Promise<boolean> {
    return this.serial(async () => {
      const before = this.devices.length;
      this.devices = this.devices.filter((device) => device.id !== id);
      if (this.devices.length === before) return false;
      await this.save();
      return true;
    });
  }

  /** Signs every device out, this one included. */
  revokeAll(): Promise<void> {
    return this.serial(async () => {
      this.devices = [];
      await this.save();
    });
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
