// The git object layer: SHA-1 object ids, loose-object encoding, trees, commits and tags, and the
// packfile format both directions. Everything here is pure bytes; the store holds the results.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export const OBJECT_TYPES: readonly ObjectType[] = ['blob', 'tree', 'commit', 'tag'];

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** `"<type> <size>\0"` plus the object's bytes: what the id hashes and a loose object stores. */
export function looseBytes(type: ObjectType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return Buffer.concat([header, data]);
}

export function hashObject(type: ObjectType, data: Buffer): string {
  return createHash('sha1').update(looseBytes(type, data)).digest('hex');
}

/** A loose object's file bytes: zlib of the header and the body. */
export function encodeLoose(type: ObjectType, data: Buffer): Buffer {
  return deflateSync(looseBytes(type, data));
}

/** Undo one loose object's zlib wrapper; null when the bytes are not a loose object. */
export function decodeLoose(raw: Buffer): GitObject | null {
  let plain: Buffer;
  try {
    plain = inflateSync(raw);
  } catch {
    return null;
  }
  const nul = plain.indexOf(0);
  if (nul < 0) return null;
  const header = plain.subarray(0, nul).toString('latin1');
  const space = header.indexOf(' ');
  if (space < 0) return null;
  const type = header.slice(0, space) as ObjectType;
  if (!OBJECT_TYPES.includes(type)) return null;
  const size = Number(header.slice(space + 1));
  const data = plain.subarray(nul + 1);
  if (!Number.isFinite(size) || size !== data.length) return null;
  return { type, data };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('latin1');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 1 + 20 > data.length) break;
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** The tree order git sorts by: a directory's name sorts as if it ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  const base = entry.name;
  return entry.mode === '40000' ? `${base}/` : base;
}

/** Build a tree object's bytes from entries, in git's required order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((left, right) => {
    const a = treeSortKey(left);
    const b = treeSortKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Everything before the message, as the object stores it. */
  headers: string[];
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const headers = head.split('\n').filter((line) => line !== '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headers) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, headers };
}

export interface CommitFields {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  /** Seconds since the epoch, written with a +0000 zone. */
  timestamp: number;
}

export function buildCommit(fields: CommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/**
 * The commit a tag or commit id ultimately names: tags are peeled, commits are returned as they are.
 * Returns null when the id is unknown or names a blob or tree.
 */
export function peelToCommit(oid: string, lookup: (id: string) => GitObject | undefined): string | null {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const tag = parseTag(object.data);
    current = tag.object;
  }
  return null;
}

// ---------------------------------------------------------------- packs

/** Whether `ancestor` is reachable from `descendant` through commit parents (both must exist). */
export function isAncestor(ancestor: string, descendant: string, lookup: (id: string) => GitObject | undefined): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

const TYPE_CODE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** One packed object's type/size header (the pack format's varint). */
function packObjectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (TYPE_CODE[type] << 4) | (remaining % 16);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining % 128;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A packfile of whole objects, no deltas, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Read one varint of the pack's type/size header; the code is the raw 3-bit type field. */
function readPackObjectHeader(buffer: Buffer, offset: number): { code: number; size: number; next: number } {
  let position = offset;
  let byte = buffer[position++]!;
  const code = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = buffer[position++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { code, size, next: position };
}

/** A pack offset's varint (used by OFS_DELTA bases). */
function readOffsetVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let position = offset;
  let byte = buffer[position++]!;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[position++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { value, next: position };
}

/** Inflate one zlib stream out of a pack and report where it ended. */
function inflateOne(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error('a pack zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 56) throw new Error('delta size varint is too long');
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
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is outside its base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
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

export interface PackRead {
  version: number;
  objects: Map<string, GitObject>;
}

/** How many passes a pack may take to resolve deltas whose base is a later object. */
const PACK_RESOLVE_PASSES = 6;

/**
 * Read a packfile's objects, resolving OFS_DELTA and REF_DELTA. `resolveBase` supplies a base a thin
 * pack leaves out. Every object's id is recomputed, so a corrupt pack cannot pass.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error(`a pack of ${pack.length} bytes is too short`);
  if (pack.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('a pack must start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const trailer = pack.subarray(end).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, end)).digest('hex');
  if (trailer !== computed) throw new Error('the pack trailer does not match its bytes');

  interface Pending {
    start: number;
    code: number;
    /** An ofs-delta's base offset, a ref-delta's base id, or nothing for a whole object. */
    baseOffset: number | null;
    baseOid: string | null;
    payload: Buffer;
  }

  const pending: Pending[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    const head = readPackObjectHeader(pack, offset);
    offset = head.next;
    if (head.code === 6) {
      const base = readOffsetVarint(pack, offset);
      offset = base.next;
      const inflated = inflateOne(pack, offset);
      offset = inflated.next;
      pending.push({ start, code: 3, baseOffset: start - base.value, baseOid: null, payload: inflated.data });
      continue;
    }
    if (head.code === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateOne(pack, offset);
      offset = inflated.next;
      pending.push({ start, code: 3, baseOffset: null, baseOid, payload: inflated.data });
      continue;
    }
    const type = CODE_TYPE[head.code];
    if (type === undefined) throw new Error(`bad pack object code ${head.code}`);
    const inflated = inflateOne(pack, offset);
    offset = inflated.next;
    if (inflated.data.length !== head.size) {
      throw new Error(`a pack object declares ${head.size} bytes and inflates to ${inflated.data.length}`);
    }
    pending.push({ start, code: head.code, baseOffset: null, baseOid: null, payload: inflated.data });
  }
  if (offset !== end) throw new Error(`the pack's objects end at ${offset}, its trailer at ${end}`);

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let remaining = pending;
  for (let pass = 0; pass < PACK_RESOLVE_PASSES && remaining.length > 0; pass += 1) {
    const still: Pending[] = [];
    for (const entry of remaining) {
      let base: GitObject | undefined;
      if (entry.baseOffset !== null) base = byOffset.get(entry.baseOffset);
      else if (entry.baseOid !== null) base = objects.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
      if (entry.baseOffset !== null || entry.baseOid !== null) {
        if (base === undefined) {
          still.push(entry);
          continue;
        }
        const delta = entry.payload;
        const object: GitObject = { type: base.type, data: applyDelta(base.data, delta) };
        byOffset.set(entry.start, object);
        objects.set(hashObject(object.type, object.data), object);
      } else {
        const type = CODE_TYPE[entry.code]!;
        const object: GitObject = { type, data: entry.payload };
        byOffset.set(entry.start, object);
        objects.set(hashObject(type, object.data), object);
      }
    }
    remaining = still;
  }
  if (remaining.length > 0) throw new Error(`${remaining.length} pack delta object(s) never found their base`);
  return { version, objects };
}
