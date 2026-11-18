// pkt-line framing: the length-prefixed lines git's smart HTTP transport exchanges.

import type { Readable } from 'node:stream';

export const PKT_MAX_PAYLOAD = 65_516;
export const FLUSH = Buffer.alloc(0);
export const DELIM = Buffer.from('0001', 'latin1');
export const RESPONSE_END = Buffer.from('0002', 'latin1');

/** One payload as a pkt-line, or a special packet when `payload` is FLUSH, DELIM or RESPONSE_END. */
export function pktLine(payload: Buffer | string): Buffer {
  if (Buffer.isBuffer(payload) && payload.length === 0) return Buffer.from('0000', 'latin1');
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  if (body.length > PKT_MAX_PAYLOAD) throw new Error(`a pkt-line payload of ${body.length} bytes is too long`);
  const header = Buffer.allocUnsafe(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/** Concatenate payloads as pkt-lines, ending with a flush packet. */
export function pktLines(payloads: readonly (Buffer | string)[]): Buffer {
  return Buffer.concat([...payloads.map((payload) => pktLine(payload)), Buffer.from('0000', 'latin1')]);
}

export interface DecodedPkt {
  /** The payload, or null for a flush, delim or response-end packet. */
  payload: Buffer | null;
  kind: 'data' | 'flush' | 'delim' | 'response-end';
}

/**
 * Decode pkt-lines up to and including the first flush, and report where the stream continued. A
 * receive-pack body is a command list followed by a raw pack, so the two need separate readers.
 */
export function decodePktLinePrefix(input: Buffer): { packets: DecodedPkt[]; consumed: number } {
  const packets: DecodedPkt[] = [];
  let offset = 0;
  while (offset + 4 <= input.length) {
    const header = input.subarray(offset, offset + 4).toString('latin1');
    if (!/^[0-9a-fA-F]{4}$/u.test(header)) throw new Error(`bad pkt-line length "${header}"`);
    const length = Number.parseInt(header, 16);
    offset += 4;
    if (length === 0) {
      packets.push({ payload: null, kind: 'flush' });
      break;
    }
    if (length === 1) {
      packets.push({ payload: null, kind: 'delim' });
      continue;
    }
    if (length === 2) {
      packets.push({ payload: null, kind: 'response-end' });
      continue;
    }
    if (offset + length - 4 > input.length) throw new Error(`pkt-line length ${length} runs past the input`);
    packets.push({ payload: input.subarray(offset, offset + length - 4), kind: 'data' });
    offset += length - 4;
  }
  return { packets, consumed: offset };
}

/** Decode a whole pkt-line stream. Throws when a length prefix is malformed. */
export function decodePktLines(input: Buffer): DecodedPkt[] {
  const out: DecodedPkt[] = [];
  let offset = 0;
  while (offset + 4 <= input.length) {
    const header = input.subarray(offset, offset + 4).toString('latin1');
    const length = Number.parseInt(header, 16);
    if (!Number.isFinite(length) || !/^[0-9a-fA-F]{4}$/u.test(header)) throw new Error(`bad pkt-line length "${header}"`);
    offset += 4;
    if (length === 0) {
      out.push({ payload: null, kind: 'flush' });
      continue;
    }
    if (length === 1) {
      out.push({ payload: null, kind: 'delim' });
      continue;
    }
    if (length === 2) {
      out.push({ payload: null, kind: 'response-end' });
      continue;
    }
    if (length < 4 || offset + length - 4 > input.length) throw new Error(`pkt-line length ${length} runs past the input`);
    out.push({ payload: input.subarray(offset, offset + length - 4), kind: 'data' });
    offset += length - 4;
  }
  return out;
}

/** The data payloads' text, trimmed of trailing newlines. */
export function pktText(decoded: readonly DecodedPkt[]): string[] {
  const out: string[] = [];
  for (const packet of decoded) {
    if (packet.payload === null) continue;
    out.push(packet.payload.toString('utf8').replace(/\n$/u, ''));
  }
  return out;
}

/** Read a whole request stream into a buffer. */
export function readStream(stream: Readable, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('the request body is too large'));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
