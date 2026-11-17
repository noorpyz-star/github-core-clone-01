// pack.ts — packfile encode/decode and pkt-line framing for the git smart-HTTP server.
//
// Packfiles: "PACK" + version (2) + count + zlib-deflated entries + 20-byte SHA-1 trailer.
// Entry types: 1 commit, 2 tree, 3 blob, 4 tag, 6 OFS_DELTA, 7 REF_DELTA. This module writes
// plain (undelted) packs and reads packs with OFS_DELTA and REF_DELTA resolution, so a real
// `git push` carrying deltas (including thin packs whose REF_DELTA bases live in the store)
// unpacks correctly.
//
// Pkt-lines: 4 hex length bytes (payload + 4), "0000" flush, "0001" delim, "0002" response-end.
// Sideband: a pkt-line whose payload starts with a band byte (1 = data, 2 = progress, 3 = error).

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, type GitObject, type ObjectType } from './store.ts';

export const PKT_LINE_MAX = 65520;

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Encode one pkt-line: 4 hex length bytes then the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error(`pkt-line payload is ${data.length} bytes, over the maximum`);
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a sequence of data lines plus flush/delim markers. */
export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from the front of `buffer` until the first flush (or the end). Returns the
 * packets and the offset just past the flush — the bytes after it are raw (a packfile).
 * Throws on a malformed length header.
 */
export function decodePktLinesUntilFlush(buffer: Buffer): { packets: PktPacket[]; restOffset: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) return { packets, restOffset: offset + 4 };
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    const raw = buffer.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return { packets, restOffset: offset };
}

/** Decode every pkt-line in a complete buffer (no trailing bytes allowed). */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const out: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX || offset + length > buffer.length) {
      throw new Error(`invalid pkt-line length ${length}`);
    }
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length), raw: buffer.subarray(offset, offset + length) });
    offset += length;
  }
  return out;
}

/** Wrap raw bytes as sideband packets (band byte + chunks), each framed as a pkt-line. */
export function sidebandWrap(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  if (data.length === 0) return Buffer.alloc(0);
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    const payload = Buffer.concat([Buffer.from([band]), slice]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects (no deltas), with its SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Buffer): string {
  if (pack.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

/** True when the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = packChecksum(pack);
  return { ok: actual === expected, expected, actual };
}

// ---------------------------------------------------------------------------
// packfile read
// ---------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
  checksumOk: boolean;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and
 * REF_DELTA. `resolveBase` supplies a base object a thin pack leaves out. Every object's
 * SHA-1 is recomputed from its resolved bytes.
 */
export function readPack(pack: Buffer, opts: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = opts.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount, checksumOk };
}
