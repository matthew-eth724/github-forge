// GitHub-compatible REST v3 under /api/v3: repositories, contents, branches, commits, refs,
// labels, issues, comments and pull requests.

import { type Issue, type Pull, type Repo, type Store, isoSeconds } from './store.ts';
import { parseCommit, parseTag, parseTree, peelToCommit } from './gitobjects.ts';
import type { Reply } from './util.ts';

const API = '/api/v3';
const INSTALLED_VERSION = '3.0.0-forge';
const OAUTH_SCOPES = 'repo, write:org, read:org, user';

export interface RestRequest {
  method: string;
  /** The path after the /api/v3 prefix, decoded into segments. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  /** Raw body, for diagnostics. */
  bodyError: boolean;
  token: string | null;
  origin: string;
}

/** A request-scoped controller handing out the deterministic per-reply id counter. */
export class RestContext {
  readonly store: Store;
  private requestCounter = 0;

  constructor(store: Store) {
    this.store = store;
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `forge-${this.requestCounter.toString(16).padStart(8, '0')}`;
  }
}

function error(status: number, message: string, headers: Record<string, string> = {}): Reply {
  return { status, body: { message }, headers };
}

function noBody(status: number, headers: Record<string, string> = {}): Reply {
  return { status, text: '', contentType: 'application/json; charset=utf-8', headers };
}

function at<T>(value: unknown, key: string): T | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, T>)[key];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) if (typeof entry === 'string') out.push(entry);
  return out;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** Split a git identity line ("Name <mail> 1234 +0000") into its parts. */
function identityOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?)\s*<([^>]*)>\s*(\d+)\s*([+-]\d{4})?$/u.exec(line);
  if (match === null) return { name: line, email: '', date: isoSeconds(0) };
  const timestamp = Number.parseInt(match[3] ?? '0', 10);
  return { name: match[1] ?? '', email: match[2] ?? '', date: isoSeconds(timestamp - 1_735_689_600) };
}

// ---------------------------------------------------------------- repository view

function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1, type: 'User', site_admin: false },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    size: 0,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${origin.replace(/^https?:\/\//u, '')}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge:${repo.owner}/${repo.name}.git`,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `${origin}${API}/repos/${repo.owner}/${repo.name}`,
  };
}

function labelJson(name: string, color: string): Record<string, unknown> {
  return { id: name.length * 7 + 1, node_id: Buffer.from(`Label${name}`, 'utf8').toString('base64'), name, color, default: false };
}

function issueJson(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  const base = `${origin}${API}/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue${issue.id}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: repo.owner, id: 1, type: 'User' },
    labels: issue.labels.map((name) => labelJson(name, repo.labels.get(name) ?? 'ededed')),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/issues/${issue.number}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
  };
}

function commentJson(repo: Repo, issue: Issue, body: string, id: number, createdAt: string, origin: string): Record<string, unknown> {
  const base = `${origin}${API}/repos/${repo.owner}/${repo.name}`;
  return {
    id,
    node_id: Buffer.from(`IssueComment${id}`, 'utf8').toString('base64'),
    body,
    user: { login: repo.owner, id: 1, type: 'User' },
    created_at: createdAt,
    updated_at: createdAt,
    issue_url: `${base}/issues/${issue.number}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${id}`,
    url: `${base}/issues/comments/${id}`,
  };
}

function pullJson(repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  const headSha = repo.branchTip(pull.head) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.base) ?? pull.baseSha;
  const base = `${origin}${API}/repos/${repo.owner}/${repo.name}`;
  const additions = pull.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = pull.files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest${pull.id}`, 'utf8').toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha ?? pull.headSha,
    mergeable: repo.pullConflicts(pull) ? 'CONFLICTING' : 'MERGEABLE',
    mergeable_state: repo.pullConflicts(pull) ? 'dirty' : 'clean',
    draft: false,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}`, user: { login: repo.owner, id: 1 } },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}`, user: { login: repo.owner, id: 1 } },
    user: { login: repo.owner, id: 1, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? pull.createdAt) : null,
    additions,
    deletions,
    changed_files: pull.files.length,
    commits: 1,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/pulls/${pull.number}`,
  };
}

function pullFileJson(repo: Repo, pull: Pull, file: Pull['files'][number], origin: string): Record<string, unknown> {
  const base = `${origin}${API}/repos/${repo.owner}/${repo.name}`;
  return {
    sha: pull.headSha,
    filename: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    blob_url: `${origin}/${repo.owner}/${repo.name}/blob/${pull.head}/${file.path}`,
    raw_url: `${origin}/${repo.owner}/${repo.name}/raw/${pull.head}/${file.path}`,
    contents_url: `${base}/contents/${file.path}`,
  };
}

// ---------------------------------------------------------------- paging

interface Page<T> {
  items: T[];
  nextPage: number | null;
}

function pageOf<T>(items: readonly T[], query: URLSearchParams): Page<T> {
  const perPage = clampInt(query.get('per_page'), 30, 1, 100);
  const page = clampInt(query.get('page'), 1, 1, 100_000);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const nextPage = start + perPage < items.length ? page + 1 : null;
  return { items: slice, nextPage };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function linkHeader(request: RestRequest, nextPage: number | null): Record<string, string> {
  if (nextPage === null) return {};
  const query = new URLSearchParams(request.query);
  query.set('page', String(nextPage));
  const path = request.segments.map((segment) => encodeURIComponent(segment)).join('/');
  return { link: `<${request.origin}${API}/${path}?${query.toString()}>; rel="next"` };
}

// ---------------------------------------------------------------- contents

interface FileView {
  oid: string;
  mode: string;
}

/** The commit a `?ref=` names: a branch, a tag, or a full object id. */
function commitForRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.headCommit();
  const asBranch = repo.branchTip(ref);
  if (asBranch !== null) return peelToCommit(asBranch, (id) => repo.get(id)) ?? asBranch;
  const asRef = repo.ref(`refs/${ref}`) ?? repo.ref(ref);
  if (asRef !== null) return peelToCommit(asRef, (id) => repo.get(id)) ?? asRef;
  if (/^[0-9a-f]{40}$/u.test(ref) && repo.has(ref)) return peelToCommit(ref, (id) => repo.get(id)) ?? ref;
  return repo.headCommit();
}

function fileEntry(repo: Repo, path: string, file: FileView, origin: string): Record<string, unknown> {
  const object = repo.get(file.oid);
  const data = object?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: data.toString('base64'),
    sha: file.oid,
    url: `${origin}${API}/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `${origin}${API}/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: `${origin}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
    _links: {},
  };
}

function dirEntry(repo: Repo, path: string, name: string, entry: FileView, origin: string, isDir: boolean): Record<string, unknown> {
  const fullPath = path === '' ? name : `${path}/${name}`;
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : (repo.get(entry.oid)?.data.length ?? 0),
    name,
    path: fullPath,
    sha: entry.oid,
    url: `${origin}${API}/repos/${repo.owner}/${repo.name}/contents/${fullPath}`,
    git_url: `${origin}${API}/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${fullPath}`,
    download_url: isDir ? null : `${origin}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${fullPath}`,
  };
}

/** The directory listing for a tree path, or null when nothing lives there. */
function listDirectory(repo: Repo, commit: string | null, path: string): Array<{ name: string; entry: FileView; isDir: boolean }> | null {
  if (commit === null) return null;
  const object = repo.get(commit);
  if (object === undefined || object.type !== 'commit') return null;
  let treeOid = parseCommit(object.data).tree;
  const segments = path.split('/').filter((segment) => segment !== '');
  for (const segment of segments) {
    const tree = repo.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const found = parseTree(tree.data).find((entry) => entry.name === segment);
    if (found === undefined) return null;
    if (found.mode !== '40000') return null;
    treeOid = found.oid;
  }
  const tree = repo.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return null;
  const out: Array<{ name: string; entry: FileView; isDir: boolean }> = [];
  for (const entry of parseTree(tree.data)) {
    out.push({ name: entry.name, entry: { oid: entry.oid, mode: entry.mode }, isDir: entry.mode === '40000' });
  }
  out.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return out;
}

function commitJson(repo: Repo, oid: string, origin: string): Record<string, unknown> | null {
  const object = repo.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  const message = view.message.replace(/\n$/u, '');
  const author = identityOf(view.author);
  const committer = identityOf(view.committer);
  const base = `${origin}${API}/repos/${repo.owner}/${repo.name}`;
  return {
    sha: oid,
    node_id: Buffer.from(`Commit${oid}`, 'utf8').toString('base64'),
    url: `${base}/commits/${oid}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${oid}`,
    commit: {
      message,
      tree: { sha: view.tree, url: `${base}/git/trees/${view.tree}` },
      author: { ...author, date: author.date },
      committer: { ...committer, date: committer.date },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: { login: repo.owner, id: 1, type: 'User', name: author.name, email: author.email },
    committer: { login: repo.owner, id: 1, type: 'User', name: committer.name, email: committer.email },
    parents: view.parents.map((parent) => ({ sha: parent, url: `${base}/commits/${parent}` })),
  };
}

// ---------------------------------------------------------------- dispatch

export function handleRest(context: RestContext, request: RestRequest): Reply {
  const { store } = context;
  const common = { 'x-oauth-scopes': OAUTH_SCOPES };
  const segments = [...request.segments];
  // A trailing slash is a directory depth, not a segment.
  while (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();

  if (request.token === null || request.token === '') {
    return error(401, 'Requires authentication', common);
  }
  if (request.bodyError) return error(400, 'Problems parsing JSON', common);

  if (segments.length === 0) {
    return {
      status: 200,
      body: {
        current_user_url: `${request.origin}${API}/user`,
        current_user_authorizations_html_url: `${request.origin}/settings/connections/applications{/client_id}`,
        repository_url: `${request.origin}${API}/repos/{owner}/{repo}`,
        user_repositories_url: `${request.origin}${API}/user/repos{?type,page,per_page,sort}`,
        emojis_url: `${request.origin}${API}/emojis`,
        rate_limit_url: `${request.origin}${API}/rate_limit`,
        installed_version: INSTALLED_VERSION,
      },
      headers: common,
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    return { status: 200, body: { installed_version: INSTALLED_VERSION, verifiable_password_authentication: true }, headers: common };
  }
  if (segments[0] === 'user' && segments.length === 1 && request.method === 'GET') {
    return { status: 200, body: { login: store.login, id: 1, type: 'User', name: store.login, site_admin: false }, headers: common };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (request.method === 'POST') return createRepo(context, request, common);
    if (request.method === 'GET') return listOwnRepos(context, request, common);
    return error(404, 'Not Found', common);
  }
  if (segments[0] === 'user' && segments[1] === 'issues' && segments.length === 2) {
    return { status: 200, body: [], headers: common };
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    return handleRepo(context, request, segments, common);
  }
  return error(404, 'Not Found', common);
}

function createRepo(context: RestContext, request: RestRequest, common: Record<string, string>): Reply {
  const name = asString(at(request.body, 'name'));
  if (name === undefined || name === '') return error(422, 'Repository creation failed: name is required', common);
  if (!NAME_PATTERN.test(name) || name.endsWith('.git')) {
    return error(422, `Repository creation failed: "${name}" is not a valid repository name`, common);
  }
  const existing = context.store.repo(context.store.login, name);
  if (existing !== undefined) return error(422, `Repository creation failed: name already exists on this account`, common);
  const isPrivate = asBoolean(at(request.body, 'private')) ?? false;
  const description = asString(at(request.body, 'description')) ?? '';
  const repo = context.store.create(context.store.login, name, isPrivate, description);
  return { status: 201, body: repoJson(repo, request.origin), headers: { ...common, location: `${request.origin}${API}/repos/${repo.owner}/${repo.name}` } };
}

function listOwnRepos(context: RestContext, request: RestRequest, common: Record<string, string>): Reply {
  const all = context.store.ownedBy(context.store.login).sort((left, right) => left.id - right.id);
  const filtered = all.filter((repo) => (request.query.get('visibility') === 'private' ? repo.isPrivate : true));
  const page = pageOf(filtered, request.query);
  return { status: 200, body: page.items.map((repo) => repoJson(repo, request.origin)), headers: { ...common, ...linkHeader(request, page.nextPage) } };
}

function handleRepo(context: RestContext, request: RestRequest, segments: string[], common: Record<string, string>): Reply {
  const { store } = context;
  const owner = segments[1] ?? '';
  const name = segments[2] ?? '';
  const rest = segments.slice(3);
  const repo = store.repo(owner, name);
  if (repo === undefined) return error(404, 'Not Found', common);

  if (rest.length === 0) {
    if (request.method === 'GET') return { status: 200, body: repoJson(repo, request.origin), headers: common };
    if (request.method === 'PATCH') {
      const description = asString(at(request.body, 'description'));
      if (description !== undefined) repo.description = description;
      return { status: 200, body: repoJson(repo, request.origin), headers: common };
    }
    if (request.method === 'DELETE') {
      store.remove(repo);
      return noBody(204, {});
    }
    return error(404, 'Not Found', common);
  }

  const [kind, ...tail] = rest;
  switch (kind) {
    case 'branches':
      return handleBranches(repo, request, tail, common);
    case 'commits':
      return handleCommits(repo, request, tail, common);
    case 'git':
      return handleGit(repo, request, tail, common);
    case 'contents':
      return handleContents(context, repo, request, tail, common);
    case 'labels':
      return handleLabels(repo, request, tail, common);
    case 'issues':
      return handleIssues(repo, request, tail, common);
    case 'pulls':
      return handlePulls(repo, request, tail, common);
    default:
      return error(404, 'Not Found', common);
  }
}

// ---------------------------------------------------------------- branches, commits, git data

function branchJson(repo: Repo, branch: string, oid: string, origin: string): Record<string, unknown> {
  const commit = commitJson(repo, oid, origin);
  return {
    name: branch,
    commit: commit ?? { sha: oid },
    protected: false,
    protected_url: `${origin}${API}/repos/${repo.owner}/${repo.name}/branches/${branch}/protection`,
  };
}

function handleBranches(repo: Repo, request: RestRequest, tail: string[], common: Record<string, string>): Reply {
  if (request.method !== 'GET') return error(404, 'Not Found', common);
  if (tail.length === 0) {
    const body = repo.heads().map((head) => branchJson(repo, head.name, head.oid, request.origin));
    return { status: 200, body, headers: common };
  }
  const branch = tail.join('/');
  const tip = repo.branchTip(branch);
  if (tip === null) return error(404, 'Branch not found', common);
  return { status: 200, body: branchJson(repo, branch, tip, request.origin), headers: common };
}

function handleCommits(repo: Repo, request: RestRequest, tail: string[], common: Record<string, string>): Reply {
  if (request.method !== 'GET') return error(404, 'Not Found', common);
  if (tail.length === 1) {
    const commit = commitJson(repo, tail[0]!, request.origin);
    if (commit === null) return error(404, 'Not Found', common);
    return { status: 200, body: commit, headers: common };
  }
  const sha = request.query.get('sha') ?? request.query.get('ref');
  let start: string | null;
  if (sha === null || sha === '') start = repo.headCommit();
  else {
    const tip = repo.branchTip(sha);
    const refOid = tip ?? repo.ref(`refs/${sha}`) ?? repo.ref(sha);
    if (refOid !== null) start = peelToCommit(refOid, (id) => repo.get(id)) ?? refOid;
    else if (/^[0-9a-f]{40}$/u.test(sha) && repo.has(sha)) start = peelToCommit(sha, (id) => repo.get(id)) ?? sha;
    else return error(404, 'No commit found for SHA or ref', common);
  }
  const path = request.query.get('path');
  const log = repo.commitLog(start, 500);
  const body: unknown[] = [];
  for (const entry of log) {
    if (path !== null && path !== '' && repo.fileAt(entry.oid, path) === null) continue;
    const json = commitJson(repo, entry.oid, request.origin);
    if (json !== null) body.push(json);
  }
  return { status: 200, body, headers: common };
}

function handleGit(repo: Repo, request: RestRequest, tail: string[], common: Record<string, string>): Reply {
  const [what, ...rest] = tail;
  if (what === 'refs') {
    if (rest.length === 0) {
      if (request.method === 'POST') {
        const ref = asString(at(request.body, 'ref'));
        const sha = asString(at(request.body, 'sha'));
        if (ref === undefined || sha === undefined) return error(422, 'Reference creation failed: ref and sha are required', common);
        if (!/^refs\//u.test(ref)) return error(422, 'Reference creation failed: ref must start with refs/', common);
        if (repo.ref(ref) !== null) return error(422, `Reference already exists: ${ref}`, common);
        if (!repo.has(sha)) return error(422, `Object does not exist: ${sha}`, common);
        repo.setRef(ref, sha);
        return { status: 201, body: { ref, node_id: Buffer.from(`Ref${ref}`, 'utf8').toString('base64'), url: `${request.origin}${API}/repos/${repo.owner}/${repo.name}/git/refs`, object: { type: 'commit', sha, url: '' } }, headers: common };
      }
      if (request.method === 'GET') {
        const body = [...repo.refs.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1)).map(([ref, sha]) => ({ ref, object: { type: 'commit', sha } }));
        return { status: 200, body, headers: common };
      }
      return error(404, 'Not Found', common);
    }
    const refPath = rest.join('/');
    const fullRef = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
    const sha = repo.ref(fullRef);
    if (sha === null) return error(404, 'Not Found', common);
    if (request.method === 'GET') {
      return { status: 200, body: { ref: fullRef, node_id: Buffer.from(`Ref${fullRef}`, 'utf8').toString('base64'), url: '', object: { type: 'commit', sha } }, headers: common };
    }
    if (request.method === 'DELETE') {
      repo.deleteRef(fullRef);
      return noBody(204, {});
    }
    return error(404, 'Not Found', common);
  }
  if (what === 'trees' && rest.length === 1) {
    const oid = rest[0]!;
    const object = repo.get(oid);
    if (object === undefined || object.type !== 'tree') return error(404, 'Not Found', common);
    const body = parseTree(object.data).map((entry) => ({ path: entry.name, mode: entry.mode, type: entry.mode === '40000' ? 'tree' : 'blob', sha: entry.oid, size: 0, url: '' }));
    return { status: 200, body: { sha: oid, url: '', tree: body, truncated: false }, headers: common };
  }
  if (what === 'blobs' && rest.length === 1) {
    const oid = rest[0]!;
    const object = repo.get(oid);
    if (object === undefined) return error(404, 'Not Found', common);
    return {
      status: 200,
      body: { sha: oid, node_id: Buffer.from(`Blob${oid}`, 'utf8').toString('base64'), size: object.data.length, url: '', content: object.data.toString('base64'), encoding: 'base64' },
      headers: common,
    };
  }
  if (what === 'tags' && rest.length === 1) {
    const oid = rest[0]!;
    const object = repo.get(oid);
    if (object === undefined || object.type !== 'tag') return error(404, 'Not Found', common);
    const view = parseTag(object.data);
    return { status: 200, body: { tag: view.tag, sha: oid, message: view.message, object: { type: view.type, sha: view.object } }, headers: common };
  }
  return error(404, 'Not Found', common);
}

// ---------------------------------------------------------------- contents

function handleContents(context: RestContext, repo: Repo, request: RestRequest, tail: string[], common: Record<string, string>): Reply {
  const path = tail.join('/');
  const ref = request.query.get('ref');

  if (request.method === 'GET') {
    const commit = commitForRef(repo, ref);
    if (path === '') return error(404, 'Not Found', common);
    const file = repo.fileAt(commit, path);
    if (file !== null) {
      return { status: 200, body: fileEntry(repo, path, file, request.origin), headers: common };
    }
    const listing = listDirectory(repo, commit, path);
    if (listing !== null && listing.length > 0) {
      return {
        status: 200,
        body: listing.map((entry) => dirEntry(repo, path, entry.name, entry.entry, request.origin, entry.isDir)),
        headers: common,
      };
    }
    return error(404, 'Not Found', common);
  }

  if (request.method === 'PUT') {
    const content = asString(at(request.body, 'content'));
    const message = asString(at(request.body, 'message')) ?? `Update ${path}`;
    const branch = asString(at(request.body, 'branch')) ?? repo.defaultBranch;
    const sha = asString(at(request.body, 'sha'));
    if (content === undefined) return error(422, 'Invalid request.\n\n"content" wasn\'t supplied.', common);
    if (path === '') return error(422, 'Invalid request: a path is required', common);
    let buffer: Buffer;
    try {
      buffer = Buffer.from(content.replace(/[\r\n\t ]+/gu, ''), 'base64');
    } catch {
      return error(422, 'Invalid request: content is not valid base64', common);
    }
    if (repo.branchTip(branch) === null && repo.headCommit() === null) {
      if (branch !== repo.defaultBranch) return error(422, `Branch ${branch} not found`, common);
    } else if (repo.branchTip(branch) === null) {
      // A branch write to a branch that does not exist yet: branch it off the default branch.
      const tip = repo.headCommit();
      if (tip === null) return error(422, `Branch ${branch} not found`, common);
      repo.setRef(`refs/heads/${branch}`, tip);
    }
    const result = repo.writeFile({ branch, path, content: buffer, message, timestamp: isoSecondsToEpoch(context.store.now()), expectedSha: sha });
    if (result === 'conflict') return error(409, `${path} does not match ${sha ?? ''}`, common);
    if (result === 'missing-branch') return error(404, 'Branch not found', common);
    const existed = sha !== undefined;
    return {
      status: existed ? 200 : 201,
      body: {
        content: { name: path.split('/').pop(), path, sha: result.blob, size: buffer.length, encoding: 'base64', content: buffer.toString('base64'), type: 'file', url: `${request.origin}${API}/repos/${repo.owner}/${repo.name}/contents/${path}` },
        commit: {
          sha: result.commit,
          message: message.endsWith('\n') ? message : `${message}\n`,
          url: `${request.origin}${API}/repos/${repo.owner}/${repo.name}/commits/${result.commit}`,
          author: { name: repo.owner, email: '', date: context.store.now() },
          committer: { name: repo.owner, email: '', date: context.store.now() },
        },
      },
      headers: common,
    };
  }

  if (request.method === 'DELETE') {
    const message = asString(at(request.body, 'message')) ?? `Delete ${path}`;
    const branch = asString(at(request.body, 'branch')) ?? repo.defaultBranch;
    const sha = asString(at(request.body, 'sha'));
    const tip = repo.branchTip(branch);
    if (tip === null) return error(404, 'Branch not found', common);
    const current = repo.fileAt(tip, path);
    if (current === null) return error(404, 'Not Found', common);
    if (sha !== undefined && sha !== current.oid) return error(409, `${path} does not match ${sha}`, common);
    const result = repo.removeFile({ branch, path, message, timestamp: isoSecondsToEpoch(context.store.now()) });
    if (result === 'missing' || result === 'missing-branch') return error(404, 'Not Found', common);
    return {
      status: 200,
      body: { content: null, commit: { sha: result.commit, message: message.endsWith('\n') ? message : `${message}\n`, url: '', author: { name: repo.owner, email: '', date: context.store.now() } } },
      headers: common,
    };
  }

  return error(404, 'Not Found', common);
}

/** Turn an ISO timestamp back into seconds for a commit header (no clock is read either way). */
function isoSecondsToEpoch(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(iso);
  if (match === null) return 1_735_689_600;
  const [, year, month, day, hour, minute, second] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Math.floor(utc / 1000);
}

// ---------------------------------------------------------------- labels, issues, comments

function handleLabels(repo: Repo, request: RestRequest, tail: string[], common: Record<string, string>): Reply {
  if (tail.length > 0) return error(404, 'Not Found', common);
  if (request.method === 'POST') {
    const name = asString(at(request.body, 'name'));
    const color = asString(at(request.body, 'color')) ?? 'ededed';
    if (name === undefined || name === '') return error(422, 'Validation Failed: name is required', common);
    repo.labels.set(name, color);
    return { status: 201, body: labelJson(name, color), headers: common };
  }
  if (request.method === 'GET') {
    return { status: 200, body: [...repo.labels.entries()].map(([name, color]) => labelJson(name, color)), headers: common };
  }
  return error(404, 'Not Found', common);
}

function handleIssues(repo: Repo, request: RestRequest, tail: string[], common: Record<string, string>): Reply {
  if (tail.length === 0) {
    if (request.method === 'POST') {
      const title = asString(at(request.body, 'title'));
      const body = asString(at(request.body, 'body')) ?? '';
      const labels = asStringArray(at(request.body, 'labels')) ?? [];
      if (title === undefined || title === '') return error(422, 'Validation Failed: title is required', common);
      const unknown = labels.filter((label) => !repo.labels.has(label));
      if (unknown.length > 0) return error(422, `Validation Failed: ${unknown.map((label) => `'${label}' is not a valid label`).join(', ')}`, common);
      const issue = repo.createIssue(title, body, labels, isoSeconds(0));
      return { status: 201, body: issueJson(repo, issue, request.origin), headers: common };
    }
    if (request.method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const sort = request.query.get('sort') ?? 'created';
      const direction = (request.query.get('direction') ?? 'desc').toLowerCase();
      let items = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      if (sort === 'created') items = [...items];
      else if (sort === 'updated') items = [...items].sort((left, right) => (left.updatedAt < right.updatedAt ? -1 : 1));
      const ascending = direction === 'asc';
      items = ascending ? items : [...items].reverse();
      const page = pageOf(items, request.query);
      return {
        status: 200,
        body: page.items.map((issue) => issueJson(repo, issue, request.origin)),
        headers: { ...common, ...linkHeader(request, page.nextPage) },
      };
    }
    return error(404, 'Not Found', common);
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  const issue = Number.isFinite(number) ? repo.issue(number) : undefined;
  if (issue === undefined) return error(404, 'Not Found', common);

  if (tail.length === 1) {
    if (request.method === 'GET') {
      // Keep `createdAt` monotonic between reads: nothing here mutates it.
      return { status: 200, body: issueJson(repo, issue, request.origin), headers: common };
    }
    if (request.method === 'PATCH') {
      const title = asString(at(request.body, 'title'));
      const body = asString(at(request.body, 'body'));
      const state = asString(at(request.body, 'state'));
      const labels = asStringArray(at(request.body, 'labels'));
      if (title !== undefined) issue.title = title;
      if (body !== undefined) issue.body = body;
      if (labels !== undefined) {
        const unknown = labels.filter((label) => !repo.labels.has(label));
        if (unknown.length > 0) return error(422, `Validation Failed: ${unknown.map((label) => `'${label}' is not a valid label`).join(', ')}`, common);
        issue.labels = [...labels];
      }
      if (state === 'closed' && issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedAt = isoSeconds(0);
      } else if (state === 'open') {
        issue.state = 'open';
        issue.closedAt = null;
      }
      issue.updatedAt = isoSeconds(0);
      return { status: 200, body: issueJson(repo, issue, request.origin), headers: common };
    }
    return error(404, 'Not Found', common);
  }

  if (tail[1] === 'comments' && tail.length === 2) {
    if (request.method === 'POST') {
      const body = asString(at(request.body, 'body'));
      if (body === undefined) return error(422, 'Validation Failed: body is required', common);
      const comment = repo.addComment(issue, body, isoSeconds(0));
      return { status: 201, body: commentJson(repo, issue, comment.body, comment.id, comment.createdAt, request.origin), headers: common };
    }
    if (request.method === 'GET') {
      return {
        status: 200,
        body: issue.comments.map((comment) => commentJson(repo, issue, comment.body, comment.id, comment.createdAt, request.origin)),
        headers: common,
      };
    }
  }
  return error(404, 'Not Found', common);
}

// ---------------------------------------------------------------- pulls

function handlePulls(repo: Repo, request: RestRequest, tail: string[], common: Record<string, string>): Reply {
  if (tail.length === 0) {
    if (request.method === 'POST') {
      const title = asString(at(request.body, 'title'));
      const body = asString(at(request.body, 'body')) ?? '';
      const head = asString(at(request.body, 'head'));
      const base = asString(at(request.body, 'base')) ?? repo.defaultBranch;
      if (title === undefined || title === '') return error(422, 'Validation Failed: title is required', common);
      if (head === undefined || head === '') return error(422, 'Validation Failed: head is required', common);
      const headRef = head.includes(':') ? head.split(':').pop()! : head;
      if (repo.branchTip(headRef) === null) return error(422, `Validation Failed: head branch ${headRef} not found`, common);
      if (repo.branchTip(base) === null) return error(422, `Validation Failed: base branch ${base} not found`, common);
      const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.head === headRef && pull.base === base);
      if (existing !== undefined) return { status: 201, body: pullJson(repo, existing, request.origin), headers: common };
      const pull = repo.createPull({ title, body, head: headRef, base, at: isoSeconds(0) });
      return { status: 201, body: pullJson(repo, pull, request.origin), headers: common };
    }
    if (request.method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      let items = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
      items = [...items].reverse();
      const page = pageOf(items, request.query);
      return {
        status: 200,
        body: page.items.map((pull) => pullJson(repo, pull, request.origin)),
        headers: { ...common, ...linkHeader(request, page.nextPage) },
      };
    }
    return error(404, 'Not Found', common);
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  const pull = Number.isFinite(number) ? repo.pull(number) : undefined;
  if (pull === undefined) return error(404, 'Not Found', common);

  if (tail.length === 1) {
    if (request.method === 'GET') return { status: 200, body: pullJson(repo, pull, request.origin), headers: common };
    if (request.method === 'PATCH') {
      const title = asString(at(request.body, 'title'));
      const body = asString(at(request.body, 'body'));
      const state = asString(at(request.body, 'state'));
      if (title !== undefined) pull.title = title;
      if (body !== undefined) pull.body = body;
      if (state === 'closed' && !pull.merged) pull.state = 'closed';
      return { status: 200, body: pullJson(repo, pull, request.origin), headers: common };
    }
    return error(404, 'Not Found', common);
  }

  if (tail[1] === 'files' && tail.length === 2) {
    if (request.method === 'GET') {
      return { status: 200, body: pull.files.map((file) => pullFileJson(repo, pull, file, request.origin)), headers: common };
    }
    return error(404, 'Not Found', common);
  }

  if (tail[1] === 'merge' && tail.length === 2 && request.method === 'PUT') {
    if (pull.merged) {
      return { status: 200, body: { sha: pull.mergeCommitSha ?? pull.headSha, merged: true, message: 'Pull request already merged' }, headers: common };
    }
    if (pull.state !== 'open') return error(405, 'Pull request is not open', common);
    if (repo.pullConflicts(pull)) return error(405, 'Pull request has conflicts and cannot be merged', common);
    const merged = repo.mergePull(pull, isoSeconds(0));
    if (merged === null) return error(405, 'Pull request cannot be merged', common);
    return { status: 200, body: { sha: merged.commit, merged: true, message: `Pull Request successfully merged` }, headers: common };
  }

  return error(404, 'Not Found', common);
}
