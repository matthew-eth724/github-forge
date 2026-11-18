// The entry's HTTP surfaces: /healthz, git smart HTTP under /{owner}/{repo}.git, REST v3 under
// /api/v3, GraphQL at /api/graphql and MCP at /mcp. Everything else is GitHub's JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { type GitService, notFound, serveInfoRefs, serveService } from './githttp.ts';
import { handleRest, RestContext, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';
import { sendJson, sendRaw, readBody } from './util.ts';
import { readStream } from './pktline.ts';

const API = '/api/v3';

/** The single account this forge serves: the user the bearer token names. */
const FORGE_LOGIN = 'adaiversen';

/** What the caller's token must be; when the env gives no token, any non-empty one is accepted. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function tokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match === null ? null : (match[1] ?? '').trim();
}

/**
 * Whether the request carries the account's token. A request with no token is unauthenticated; a
 * wrong token is too. When the env configured no token, any presented token is the account's.
 */
function authenticated(req: IncomingMessage): boolean {
  const token = tokenOf(req);
  if (token === null || token === '') return false;
  const expected = expectedToken();
  return expected === '' || token === expected;
}

interface Target {
  pathname: string;
  query: URLSearchParams;
}

function targetOf(req: IncomingMessage): Target {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return typeof host === 'string' && host !== '' ? `http://${host}` : 'http://127.0.0.1';
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function withHeaders(headers: Record<string, string> | undefined, extra: Record<string, string>): Record<string, string> {
  return { ...(headers ?? {}), ...extra };
}

/** Answer a REST/GraphQL/MCP reply, adding the request id every reply carries. */
function replyJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  sendJson(res, status, body, headers);
}

function replyRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string>): void {
  sendRaw(res, status, body, contentType, headers);
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function notFoundJson(res: ServerResponse, extra: Record<string, string>): void {
  sendJson(res, 404, { message: 'Not Found' }, { 'content-type': 'application/json; charset=utf-8', ...extra });
}

/** Build the forge's server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store(FORGE_LOGIN);
  const restContext = new RestContext(store);

  return createServer((req, res) => {
    void handle(store, restContext, req, res).catch((err: unknown) => {
      if (process.env.FORGE_DEBUG === '1') process.stderr.write(`[forge] ${req.method ?? ''} ${req.url ?? ''} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' }, { 'content-type': 'application/json; charset=utf-8' });
        } catch {
          // The socket is already gone.
        }
      }
    });
  });
}

async function handle(store: Store, restContext: RestContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname, query } = targetOf(req);
  const method = req.method ?? 'GET';
  const origin = originOf(req);
  const id = requestId();
  const idHeader = { 'x-github-request-id': id };

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/graphql' || pathname === '/api/graphql/') {
    const body = await readBody(req);
    if (body === null) {
      replyJson(res, 413, { message: 'Request Entity Too Large' }, idHeader);
      return;
    }
    const outcome = handleGraphQL(store, {
      method,
      origin,
      token: authenticated(req) ? (tokenOf(req) ?? '') : null,
      raw: body,
    });
    replyJson(res, outcome.status, outcome.body, withHeaders(outcome.headers, idHeader));
    return;
  }

  if (pathname === '/mcp' || pathname === '/mcp/') {
    const body = await readBody(req);
    if (body === null) {
      replyJson(res, 413, { message: 'Request Entity Too Large' }, idHeader);
      return;
    }
    const outcome = handleMcp(store, {
      method,
      origin,
      token: authenticated(req) ? (tokenOf(req) ?? '') : null,
      raw: body,
      headers: req.headers,
    });
    if (outcome.text !== undefined) {
      replyRaw(res, outcome.status, Buffer.from(outcome.text, 'utf8'), outcome.contentType, withHeaders(outcome.headers, idHeader));
      return;
    }
    replyJson(res, outcome.status, outcome.body, withHeaders(outcome.headers, idHeader));
    return;
  }

  if (pathname === API || pathname === `${API}/` || pathname.startsWith(`${API}/`)) {
    const segments = pathname
      .slice(API.length)
      .split('/')
      .filter((segment) => segment !== '');
    const decoded = segments.map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
    const body = await readBody(req);
    if (body === null) {
      replyJson(res, 413, { message: 'Request Entity Too Large' }, idHeader);
      return;
    }
    let parsed: unknown = undefined;
    let bodyError = false;
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        bodyError = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
      }
    }
    const request: RestRequest = {
      method,
      segments: decoded,
      query,
      body: parsed,
      bodyError,
      token: authenticated(req) ? (tokenOf(req) ?? '') : null,
      origin,
    };
    const reply = handleRest(restContext, request);
    if (reply.text !== undefined) {
      replyRaw(res, reply.status, Buffer.from(reply.text, 'utf8'), reply.contentType ?? 'application/json; charset=utf-8', withHeaders(reply.headers, idHeader));
      return;
    }
    replyJson(res, reply.status, reply.body ?? null, withHeaders(reply.headers, idHeader));
    return;
  }

  if (pathname === '/') {
    notFoundJson(res, idHeader);
    return;
  }

  // git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)$/u.exec(pathname);
  if (gitMatch !== null) {
    const owner = safeDecode(gitMatch[1]!);
    const repoName = safeDecode(gitMatch[2]!);
    const tail = gitMatch[3]!;
    const repo = store.repo(owner, repoName);
    const service: GitService | null = /\/git-upload-pack$/u.test(tail)
      ? 'git-upload-pack'
      : /\/git-receive-pack$/u.test(tail)
        ? 'git-receive-pack'
        : null;
    if (/\/info\/refs$/u.test(tail)) {
      const requested = query.get('service');
      if (requested !== 'git-upload-pack' && requested !== 'git-receive-pack') {
        notFound(res);
        return;
      }
      if (!authenticated(req)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="forge"' });
        res.end('authentication required\n');
        return;
      }
      if (repo === undefined) {
        notFound(res);
        return;
      }
      const gitProtocol = String(req.headers['git-protocol'] ?? '');
      serveInfoRefs(repo, requested, /version=2/u.test(gitProtocol), res);
      return;
    }
    if (service !== null) {
      if (method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-length': '0' });
        res.end();
        return;
      }
      const body = await readStream(req, 128 * 1024 * 1024);
      if (!authenticated(req)) {
        notFound(res);
        return;
      }
      if (repo === undefined) {
        notFound(res);
        return;
      }
      try {
        serveService(repo, service, body, /version=2/u.test(String(req.headers['git-protocol'] ?? '')), res);
      } catch (err) {
        // A malformed request is the client's problem; the server stays up.
        if (process.env.FORGE_DEBUG === '1') process.stderr.write(`[forge] upload-pack failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        if (!res.headersSent) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('malformed request\n');
        }
      }
      return;
    }
  }

  notFoundJson(res, idHeader);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export { gzipSync };
