// Small HTTP and encoding helpers shared by every surface.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The largest request body any surface accepts (contents PUTs are the biggest). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  text?: string;
  contentType?: string;
}

function write(res: ServerResponse, status: number, text: string, headers: Record<string, string>): void {
  try {
    res.writeHead(status, headers);
    res.end(text);
  } catch {
    // The peer went away between the request and the answer.
  }
}

/** Answer with a JSON body and a content-length. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body ?? null);
  write(res, status, text, {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  });
}

/** Answer with raw bytes and a content type. */
export function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  write(res, status, body.toString('binary'), {
    'content-type': contentType,
    'content-length': String(body.length),
    ...headers,
  });
  // `binary` keeps every byte: latin1 round-trips 0x00..0xff exactly.
}

/** Read a request body, or null when it is past the cap. */
export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

export function b64(text: string | Buffer): string {
  return Buffer.from(text as never).toString('base64');
}

export function unb64(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** A base64url encoding of an opaque id (the Relay global ids). */
export function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function fromBase64Url(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

/** A fixed epoch for every generated timestamp: generated data never reads a clock. */
export const FIXED_EPOCH_SEC = 1_735_689_600;

/**
 * An ISO-8601 timestamp `offset` seconds after the fixed epoch. Days are converted with the civil-from-days
 * algorithm rather than a Date object, so nothing here reads a clock.
 */
export function isoTimestamp(offset: number): string {
  const total = FIXED_EPOCH_SEC + Math.max(0, Math.trunc(offset));
  const days = Math.floor(total / 86_400);
  const rest = total - days * 86_400;
  const hour = Math.floor(rest / 3600);
  const minute = Math.floor((rest - hour * 3600) / 60);
  const second = rest - hour * 3600 - minute * 60;
  // Howard Hinnant's civil_from_days, with the epoch shifted to 0000-03-01.
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y0 = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = y0 + (month <= 2 ? 1 : 0);
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}Z`;
}
