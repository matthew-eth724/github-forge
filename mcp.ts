// Model Context Protocol over streamable HTTP at /mcp: the 2026-07-28 revision (server/discover, no
// handshake, no session) and the handshake revisions that came before it. The tools are thin shells
// over the same store the REST surface serves, so a repository or issue created here reads back there.

import type { IncomingMessage } from 'node:http';
import { type Issue, type Pull, type Repo, type Store, isoSeconds } from './store.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface McpRequest {
  method: string;
  origin: string;
  token: string | null;
  raw: Buffer;
  headers: IncomingMessage['headers'];
}

export interface McpOutcome {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  text?: string;
  contentType?: string;
}

// ---------------------------------------------------------------- tools

interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
}

function textProperty(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

/** The tool catalogue. Every list answer is this same frozen array, so two tools/list replies match. */
const TOOLS: readonly Tool[] = Object.freeze([
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a repository owned by the authenticated account. Returns the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: textProperty('The repository name.'),
        description: textProperty('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Read one repository by owner and name. Returns the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: textProperty('The account login that owns the repository.'),
        repo: textProperty('The repository name.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open an issue on a repository. Returns the issue object with its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: textProperty('The account login that owns the repository.'),
        repo: textProperty('The repository name.'),
        title: textProperty('The issue title.'),
        body: textProperty('The issue body, in Markdown.'),
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, newest first. Returns an array of issue objects.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: textProperty('The account login that owns the repository.'),
        repo: textProperty('The repository name.'),
        state: textProperty('Only issues in this state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch. Returns the pull request object.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: textProperty('The account login that owns the repository.'),
        repo: textProperty('The repository name.'),
        title: textProperty('The pull request title.'),
        body: textProperty('The pull request body, in Markdown.'),
        head: textProperty('The branch the changes come from.'),
        base: textProperty('The branch the changes go into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge an open pull request into its base branch. Returns the merged pull request object.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: textProperty('The account login that owns the repository.'),
        repo: textProperty('The repository name.'),
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    title: 'List pull requests',
    description: 'List the pull requests of a repository. Returns an array of pull request objects.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: textProperty('The account login that owns the repository.'),
        repo: textProperty('The repository name.'),
        state: textProperty('Only pull requests in this state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue_comment',
    title: 'Create issue comment',
    description: 'Add a comment to an issue. Returns the comment object.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: textProperty('The account login that owns the repository.'),
        repo: textProperty('The repository name.'),
        issue_number: { type: 'number', description: 'The issue number.' },
        body: textProperty('The comment body, in Markdown.'),
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
      additionalProperties: false,
    },
  },
]);

// ---------------------------------------------------------------- argument reading

class ToolFailure extends Error {}

function argString(args: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function argNumber(args: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^\d+$/u.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

/** The owner and repository a tool call names, from the usual property spellings. */
function ownerAndRepo(store: Store, args: Record<string, unknown>): { owner: string; repo: string } {
  const fullName = argString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if (fullName !== null && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/', 2);
    if (owner !== undefined && repo !== undefined && owner !== '' && repo !== '') return { owner, repo };
  }
  const owner = argString(args, ['owner', 'owner_login', 'org', 'organization', 'login']) ?? store.login;
  const repo = argString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'name']);
  if (repo === null) throw new ToolFailure('the call names no repository');
  return { owner, repo };
}

function requireRepo(store: Store, args: Record<string, unknown>): { repo: Repo; owner: string; name: string } {
  const named = ownerAndRepo(store, args);
  const repo = store.repo(named.owner, named.repo);
  if (repo === undefined) throw new ToolFailure(`repository not found: ${named.owner}/${named.repo}`);
  return { repo, owner: named.owner, name: named.repo };
}

// ---------------------------------------------------------------- JSON views

function repoView(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    created_at: repo.createdAt,
    html_url: `${origin}/${repo.fullName}`,
  };
}

function issueView(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    repository: repo.fullName,
    html_url: `${origin}/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    head: { ref: pull.head, sha: repo.branchTip(pull.head) ?? pull.headSha },
    base: { ref: pull.base, sha: repo.branchTip(pull.base) ?? pull.baseSha },
    repository: repo.fullName,
    html_url: `${origin}/${repo.fullName}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------- tool calls

interface ToolOutcome {
  value: unknown;
  text: string;
}

function callTool(store: Store, origin: string, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, ['name', 'repo', 'repository', 'repository_name']);
      if (repoName === null) throw new ToolFailure('create_repo needs a name');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(repoName) || repoName.endsWith('.git')) throw new ToolFailure(`"${repoName}" is not a valid repository name`);
      const existing = store.repo(store.login, repoName);
      if (existing !== undefined) throw new ToolFailure(`repository ${store.login}/${repoName} already exists`);
      const isPrivate = args.private === true;
      const description = argString(args, ['description', 'about', 'summary']) ?? '';
      const repo = store.create(store.login, repoName, isPrivate, description);
      const view = repoView(repo, origin);
      return { value: view, text: JSON.stringify(view) };
    }
    case 'get_repo': {
      const { repo } = requireRepo(store, args);
      const view = repoView(repo, origin);
      return { value: view, text: JSON.stringify(view) };
    }
    case 'create_issue': {
      const { repo } = requireRepo(store, args);
      const title = argString(args, ['title', 'issue_title', 'subject']);
      if (title === null) throw new ToolFailure('create_issue needs a title');
      const body = argString(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
      const issue = repo.createIssue(title, body, [], isoSeconds(0));
      const view = issueView(repo, issue, origin);
      return { value: view, text: JSON.stringify(view) };
    }
    case 'list_issues': {
      const { repo } = requireRepo(store, args);
      const state = (argString(args, ['state', 'status']) ?? 'open').toLowerCase();
      const items = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((left, right) => right.number - left.number)
        .map((issue) => issueView(repo, issue, origin));
      return { value: items, text: JSON.stringify(items) };
    }
    case 'create_pull_request': {
      const { repo } = requireRepo(store, args);
      const title = argString(args, ['title', 'pr_title', 'pull_request_title']) ?? '';
      const body = argString(args, ['body', 'description']) ?? '';
      const head = argString(args, ['head', 'head_ref', 'head_branch', 'source', 'from']);
      const base = argString(args, ['base', 'base_ref', 'base_branch', 'target', 'into']) ?? repo.defaultBranch;
      if (head === null) throw new ToolFailure('create_pull_request needs a head branch');
      if (repo.branchTip(head) === null) throw new ToolFailure(`head branch ${head} does not exist`);
      if (repo.branchTip(base) === null) throw new ToolFailure(`base branch ${base} does not exist`);
      const pull = repo.createPull({ title, body, head, base, at: isoSeconds(0) });
      const view = pullView(repo, pull, origin);
      return { value: view, text: JSON.stringify(view) };
    }
    case 'merge_pull_request': {
      const { repo } = requireRepo(store, args);
      const number = argNumber(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number']);
      if (number === null) throw new ToolFailure('merge_pull_request needs a pull_number');
      const pull = repo.pull(number);
      if (pull === undefined) throw new ToolFailure(`pull request #${number} does not exist`);
      if (!pull.merged) {
        if (repo.pullConflicts(pull)) throw new ToolFailure(`pull request #${number} conflicts with ${pull.base}`);
        repo.mergePull(pull, isoSeconds(0));
      }
      const view = pullView(repo, pull, origin);
      return { value: view, text: JSON.stringify(view) };
    }
    case 'list_pull_requests': {
      const { repo } = requireRepo(store, args);
      const state = (argString(args, ['state', 'status']) ?? 'open').toLowerCase();
      const items = repo.pulls
        .filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === 'open'))
        .sort((left, right) => right.number - left.number)
        .map((pull) => pullView(repo, pull, origin));
      return { value: items, text: JSON.stringify(items) };
    }
    case 'create_issue_comment': {
      const { repo } = requireRepo(store, args);
      const number = argNumber(args, ['issue_number', 'number']);
      if (number === null) throw new ToolFailure('create_issue_comment needs an issue_number');
      const issue = repo.issue(number);
      if (issue === undefined) throw new ToolFailure(`issue #${number} does not exist`);
      const body = argString(args, ['body', 'comment', 'text']) ?? '';
      const comment = repo.addComment(issue, body, isoSeconds(0));
      const view = { id: comment.id, body: comment.body, user: { login: store.login }, created_at: comment.createdAt, issue_number: issue.number };
      return { value: view, text: JSON.stringify(view) };
    }
    default:
      throw new ToolFailure(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [PREFERRED_REVISION, ...LEGACY_REVISIONS],
    capabilities: { tools: { listChanged: false } },
    instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
    serverInfo: serverInfo(),
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
  };
}

function toolList(): Record<string, unknown> {
  return { tools: TOOLS.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema })) };
}

function missingRequired(tool: Tool, args: Record<string, unknown>): string[] {
  const required = tool.inputSchema.required ?? [];
  return required.filter((name) => !(name in args));
}

/** Answer one JSON-RPC message. `null` means "no content" (a notification). */
function handleMessage(store: Store, origin: string, message: unknown): Record<string, unknown> | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return rpcError(null, INVALID_REQUEST, 'Invalid Request: a JSON-RPC message must be an object');
  }
  const request = message as RpcRequest;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  if (method === '') return rpcError(id, INVALID_REQUEST, 'Invalid Request: no method');
  const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params) ? (request.params as Record<string, unknown>) : {};

  switch (method) {
    case 'server/discover':
      return result(id, discoverResult());
    case 'initialize':
      return result(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PREFERRED_REVISION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo(),
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'ping':
      return method === 'ping' ? result(id, {}) : null;
    case 'tools/list':
      return result(id, toolList());
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) return rpcError(id, INVALID_PARAMS, `unknown tool: ${name}`);
      const missing = missingRequired(tool, args);
      if (missing.length > 0) return rpcError(id, INVALID_PARAMS, `missing required arguments: ${missing.join(', ')}`);
      try {
        const outcome = callTool(store, origin, name, args);
        return result(id, {
          content: [{ type: 'text', text: outcome.text }],
          structuredContent: outcome.value,
          isError: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'the tool failed';
        return result(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------- the HTTP surface

const MCP_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

export function handleMcp(store: Store, request: McpRequest): McpOutcome {
  const authHeader = request.headers.authorization;
  const bearer = typeof authHeader === 'string' ? /^Bearer\s+(.+)$/iu.exec(authHeader.trim()) : null;
  const token = bearer === null ? '' : (bearer[1] ?? '').trim();
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '' || (expected !== '' && token !== expected)) {
    return { status: 401, body: { message: 'Requires authentication' }, headers: { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Bearer' } };
  }

  if (request.method === 'DELETE') return { status: 204, text: '', contentType: 'application/json; charset=utf-8' };
  if (request.method === 'GET') return { status: 405, body: { message: 'Method Not Allowed' }, headers: { allow: 'POST' } };
  if (request.method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' }, headers: { allow: 'POST' } };

  const text = request.raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { status: 400, body: rpcError(null, PARSE_ERROR, 'Parse error: the body is not JSON'), headers: MCP_HEADERS };
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const answers: unknown[] = [];
  for (const message of messages) {
    const answer = handleMessage(store, request.origin, message);
    if (answer !== null) answers.push(answer);
  }
  if (answers.length === 0) return { status: 202, text: '', contentType: 'application/json; charset=utf-8' };
  if (!Array.isArray(parsed)) return { status: 200, body: answers[0], headers: MCP_HEADERS };
  return { status: 200, body: answers, headers: MCP_HEADERS };
}

export { TOOLS as MCP_TOOLS };
