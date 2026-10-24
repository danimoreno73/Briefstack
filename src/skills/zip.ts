import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer for the skill archives of `claude-app` projects
 * (docs/decisions.md, phase 6 H0 point 3): deflated entries, a fixed date
 * so the same files always give the same bytes, and the Unix mode of
 * executable files. No dependency: `node:zlib` has deflate and CRC-32.
 */

export interface ZipEntry {
  /** Path inside the archive, with `/`. */
  path: string;
  bytes: Buffer;
  executable?: boolean;
}

/** 1980-01-01 00:00, the earliest DOS date: archives do not depend on when they were made. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const deflated = deflateRawSync(entry.bytes, { level: 9 });
    const stored = deflated.length >= entry.bytes.length;
    const data = stored ? entry.bytes : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.bytes) >>> 0;
    // Bit 11: the name is UTF-8.
    const flags = 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const mode = entry.executable === true ? 0o100755 : 0o100644;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Made by Unix (3), version 2.0, so readers apply the mode.
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Reads back an archive `buildZip` wrote: names and bytes. For tests and the validator. */
export function readZip(zip: Buffer): ZipEntry[] {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(endAt + 10);
  let at = zip.readUInt32LE(endAt + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localName = zip.readUInt16LE(localAt + 26);
    const localExtra = zip.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localName + localExtra;
    const data = zip.subarray(start, start + compressed);
    const bytes = method === 0 ? Buffer.from(data) : inflateRawSync(data);
    out.push({ path: name, bytes, executable: (mode & 0o111) !== 0 });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
