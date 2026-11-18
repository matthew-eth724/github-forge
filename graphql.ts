// GitHub GraphQL v4 at /api/graphql: a small parser and executor for the documents gh and
// github-mcp-server actually send (viewer, repository, __type probes, issues, pull requests,
// the create/close/merge mutations, and operation batching).

import { type Issue, type Pull, type Repo, type Store, isoSeconds } from './store.ts';
import { parseCommit } from './gitobjects.ts';

// ---------------------------------------------------------------- the document model

type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'enum' | 'variable' | 'list' | 'object';

interface Value {
  kind: ValueKind;
  /** A string's text, a number's digits, an enum's name, a variable's name, or the raw literal. */
  text: string;
  list?: Value[];
  object?: Map<string, Value>;
}

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class ParseError extends Error {}

function isNameStart(ch: string): boolean {
  return /[A-Za-z_]/u.test(ch);
}

function isNamePart(ch: string): boolean {
  return /[A-Za-z0-9_]/u.test(ch);
}

class Parser {
  private offset = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  private get ch(): string {
    return this.source[this.offset] ?? '';
  }

  private skipIgnored(): void {
    for (;;) {
      const ch = this.ch;
      if (ch === '' ) return;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.offset += 1;
        continue;
      }
      if (ch === '#') {
        while (this.offset < this.source.length && this.ch !== '\n') this.offset += 1;
        continue;
      }
      return;
    }
  }

  private expect(text: string): void {
    this.skipIgnored();
    if (!this.source.startsWith(text, this.offset)) {
      throw new ParseError(`expected ${JSON.stringify(text)} at offset ${this.offset}`);
    }
    this.offset += text.length;
  }

  private peek(text: string): boolean {
    this.skipIgnored();
    return this.source.startsWith(text, this.offset);
  }

  private name(): string {
    this.skipIgnored();
    if (!isNameStart(this.ch)) throw new ParseError(`expected a name at offset ${this.offset}`);
    const start = this.offset;
    while (this.offset < this.source.length && isNamePart(this.ch)) this.offset += 1;
    return this.source.slice(start, this.offset);
  }

  /** One whole operation from the body. */
  document(): Operation {
    this.skipIgnored();
    let kind: 'query' | 'mutation' = 'query';
    if (this.peek('mutation')) {
      this.offset += 'mutation'.length;
      kind = 'mutation';
    } else if (this.peek('query')) {
      this.offset += 'query'.length;
    }
    let name: string | null = null;
    this.skipIgnored();
    if (isNameStart(this.ch)) name = this.name();
    // Variable definitions: parse and ignore, variables arrive in the request's variables object.
    if (this.peek('(')) this.skipBalanced('(', ')');
    if (this.peek('@')) this.skipDirectives();
    const selections = this.selectionSet();
    this.skipIgnored();
    return { kind, name, selections };
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (this.offset < this.source.length && depth > 0) {
      const ch = this.ch;
      if (ch === '"') {
        this.string();
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) depth -= 1;
      this.offset += 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek('@')) {
      this.offset += 1;
      this.name();
      if (this.peek('(')) this.skipBalanced('(', ')');
    }
  }

  private string(): string {
    this.expect('"');
    if (this.peek('""')) {
      // A block string: three quotes, everything until the closing three.
      this.offset += 2;
      const end = this.source.indexOf('"""', this.offset);
      const text = end < 0 ? this.source.slice(this.offset) : this.source.slice(this.offset, end);
      this.offset = end < 0 ? this.source.length : end + 3;
      return text;
    }
    let out = '';
    while (this.offset < this.source.length) {
      const ch = this.ch;
      this.offset += 1;
      if (ch === '"') return out;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const escape = this.ch;
      this.offset += 1;
      if (escape === 'n') out += '\n';
      else if (escape === 't') out += '\t';
      else if (escape === 'r') out += '\r';
      else if (escape === 'b') out += '\b';
      else if (escape === 'f') out += '\f';
      else if (escape === 'u') {
        const hex = this.source.slice(this.offset, this.offset + 4);
        this.offset += 4;
        out += String.fromCharCode(Number.parseInt(hex, 16));
      } else out += escape;
    }
    throw new ParseError('an unterminated string');
  }

  private value(): Value {
    this.skipIgnored();
    const ch = this.ch;
    if (ch === '$') {
      this.offset += 1;
      return { kind: 'variable', text: this.name() };
    }
    if (ch === '"') return { kind: 'string', text: this.string() };
    if (ch === '[') {
      this.offset += 1;
      const list: Value[] = [];
      for (;;) {
        this.skipIgnored();
        if (this.ch === ']') {
          this.offset += 1;
          break;
        }
        list.push(this.value());
      }
      return { kind: 'list', text: '', list };
    }
    if (ch === '{') {
      this.offset += 1;
      const object = new Map<string, Value>();
      for (;;) {
        this.skipIgnored();
        if (this.ch === '}') {
          this.offset += 1;
          break;
        }
        const key = this.name();
        this.expect(':');
        object.set(key, this.value());
      }
      return { kind: 'object', text: '', object };
    }
    if (this.source.startsWith('true', this.offset)) {
      this.offset += 4;
      return { kind: 'boolean', text: 'true' };
    }
    if (this.source.startsWith('false', this.offset)) {
      this.offset += 5;
      return { kind: 'boolean', text: 'false' };
    }
    if (this.source.startsWith('null', this.offset)) {
      this.offset += 4;
      return { kind: 'null', text: 'null' };
    }
    if (/[-0-9]/u.test(ch)) {
      const start = this.offset;
      if (ch === '-') this.offset += 1;
      while (/[0-9.eE+-]/u.test(this.ch)) this.offset += 1;
      return { kind: 'number', text: this.source.slice(start, this.offset) };
    }
    return { kind: 'enum', text: this.name() };
  }

  private selectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.ch === '}') {
        this.offset += 1;
        break;
      }
      if (this.ch === '') throw new ParseError('an unterminated selection set');
      if (this.source.startsWith('...', this.offset)) {
        this.offset += 3;
        this.skipIgnored();
        if (this.source.startsWith('on', this.offset) && !isNamePart(this.source[this.offset + 2] ?? '')) {
          this.offset += 2;
          const typeCondition = this.name();
          if (this.peek('@')) this.skipDirectives();
          selections.push({ kind: 'fragment', typeCondition, selections: this.selectionSet() });
          continue;
        }
        // A named fragment spread or an inline fragment without a type: keep its selections empty.
        if (isNameStart(this.ch)) this.name();
        if (this.peek('@')) this.skipDirectives();
        if (this.peek('{')) this.selectionSet();
        continue;
      }
      selections.push(this.field());
    }
    return selections;
  }

  private field(): FieldSelection {
    const first = this.name();
    this.skipIgnored();
    let alias: string | null = null;
    let name = first;
    if (this.ch === ':') {
      this.offset += 1;
      alias = first;
      name = this.name();
    }
    const args = new Map<string, Value>();
    if (this.peek('(')) {
      this.offset += 1;
      for (;;) {
        this.skipIgnored();
        if (this.ch === ')') {
          this.offset += 1;
          break;
        }
        const argName = this.name();
        this.expect(':');
        args.set(argName, this.value());
      }
    }
    if (this.peek('@')) this.skipDirectives();
    const selections = this.peek('{') ? this.selectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }
}

// ---------------------------------------------------------------- execution

interface GraphQLErrorBody {
  message: string;
  path?: Array<string | number>;
  locations?: Array<{ line: number; column: number }>;
  extensions?: Record<string, unknown>;
}

class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldError';
  }
}

type Variables = Record<string, unknown>;

/** Resolve a Value against the request's variables. */
function resolveValue(value: Value | undefined, variables: Variables): unknown {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'string':
    case 'enum':
      return value.text;
    case 'number':
      return Number(value.text);
    case 'boolean':
      return value.text === 'true';
    case 'null':
      return null;
    case 'variable':
      return variables[value.text];
    case 'list':
      return (value.list ?? []).map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.object ?? []) out[key] = resolveValue(entry, variables);
      return out;
    }
    default:
      return undefined;
  }
}

function argOf(field: FieldSelection, name: string, variables: Variables): unknown {
  return resolveValue(field.args.get(name), variables);
}

/** A field's answer for a built-in scalar or a leaf. */
function scalar(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** The Relay global id of one entity. */
function globalId(kind: string, id: number): string {
  return Buffer.from(`${kind}${id}`, 'utf8').toString('base64');
}

/** Decode a Relay global id back into its kind and numeric id, or null. */
function decodeGlobalId(id: string): { kind: string; id: number } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([A-Za-z]+)(\d+)$/u.exec(text);
  if (match === null) return null;
  return { kind: match[1]!, id: Number.parseInt(match[2]!, 10) };
}

/** The schema surface gh's feature detection reads, as the names each type lists. */
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closed', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files', 'isDraft', 'author', 'createdAt', 'updatedAt', 'baseRef', 'headRef', 'mergeCommit', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'url', 'stargazerCount'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name', 'target'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
});

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
});

const ISSUE_ORDER_FIELD_ARG = 'field';

/** One execution's working set. */
class Executor {
  private readonly errors: GraphQLErrorBody[] = [];
  readonly store: Store;
  private readonly origin: string;
  readonly variables: Variables;

  constructor(store: Store, origin: string, variables: Variables) {
    this.store = store;
    this.origin = origin;
    this.variables = variables;
  }

  failures(): GraphQLErrorBody[] {
    return this.errors;
  }

  /** Resolve one selection set against a value of `typeName`. */
  object(typeName: string, source: unknown, selections: readonly Selection[]): Record<string, unknown> | null {
    if (source === null || source === undefined) return null;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (typeMatches(typeName, selection.typeCondition)) {
          const merged = this.object(typeName, source, selection.selections);
          if (merged !== null) Object.assign(out, merged);
        }
        continue;
      }
      const key = selection.alias ?? selection.name;
      try {
        out[key] = this.field(typeName, source, selection);
      } catch (err) {
        if (err instanceof FieldError) {
          this.errors.push({ message: err.message, path: [key] });
          out[key] = null;
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  private field(typeName: string, source: unknown, field: FieldSelection): unknown {
    const known = TYPE_FIELDS[typeName];
    if (known !== undefined && !known.includes(field.name)) {
      throw new FieldError(`Field '${field.name}' doesn't exist on type '${typeName}'`);
    }
    const handlers = this.handlersFor(typeName);
    const handler = handlers[field.name];
    if (handler === undefined) {
      throw new FieldError(`Field '${field.name}' doesn't exist on type '${typeName}'`);
    }
    return handler(source, field, this);
  }

  private handlersFor(typeName: string): Record<string, Handler> {
    const handlers = HANDLERS[typeName];
    if (handlers === undefined) throw new FieldError(`Cannot query field '${typeName}'`);
    return handlers;
  }

  /** Resolve a nested selection set of the named type. */
  select(typeName: string, source: unknown, field: FieldSelection): unknown {
    return this.object(typeName, source, field.selections);
  }

  globalIdOf(kind: string, id: number): string {
    return globalId(kind, id);
  }

  get originUrl(): string {
    return this.origin;
  }

  /** Record a field error (a mutation whose subject vanished). */
  fail(message: string): null {
    this.errors.push({ message });
    return null;
  }
}

type Handler = (source: unknown, field: FieldSelection, executor: Executor) => unknown;

function typeMatches(actual: string, condition: string): boolean {
  return actual === condition;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function repoOf(value: unknown): Repo {
  return value as Repo;
}

function issueOf(value: unknown): Issue {
  return value as Issue;
}

function pullOf(value: unknown): Pull {
  return value as Pull;
}

/** The issue states a list request filters on. */
function statesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/** A cursor is the index of the next item, base64-encoded, so it is opaque on the wire. */
function cursorAt(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: string | null): number {
  if (cursor === null || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/u.exec(text);
    return match === null ? 0 : Number.parseInt(match[1]!, 10);
  } catch {
    return 0;
  }
}

function pageSizeOf(first: unknown, fallback = 100): number {
  if (typeof first !== 'number' || !Number.isFinite(first) || first <= 0) return fallback;
  return Math.min(100, Math.trunc(first));
}

const HANDLERS: Readonly<Record<string, Readonly<Record<string, Handler>>>> = Object.freeze({
  Query: {
    viewer: (_source, field, executor) => executor.select('User', { login: executor.store.login }, field),
    repository: (_source, field, executor) => {
      const owner = argOf(field, 'owner', executor.variables);
      const name = argOf(field, 'name', executor.variables);
      const repo = typeof owner === 'string' && typeof name === 'string' ? executor.store.repo(owner, name) : undefined;
      return executor.select('Repository', repo ?? null, field);
    },
    node: (_source, field, executor) => {
      const id = argOf(field, 'id', executor.variables);
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = executor.store.repoById(decoded.id);
        return executor.select('Repository', repo ?? null, field);
      }
      if (decoded.kind === 'Issue') {
        for (const repo of executor.store.all()) {
          const issue = repo.issues.find((entry) => entry.id === decoded.id);
          if (issue !== undefined) return executor.select('Issue', issue, field);
        }
        return null;
      }
      return null;
    },
    __type: (_source, field, executor) => {
      const name = argOf(field, 'name', executor.variables);
      const typeName = typeof name === 'string' ? name : '';
      const fields = TYPE_FIELDS[typeName];
      const enums = TYPE_ENUMS[typeName];
      if (fields === undefined && enums === undefined) return null;
      return executor.select('__Type', { name: typeName }, field);
    },
    __schema: () => null,
    rateLimit: () => null,
  },
  Mutation: {
    createIssue: (_source, field, executor) => {
      const input = recordOf(argOf(field, 'input', executor.variables));
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repositoryId);
      const repo = decoded === null ? undefined : executor.store.repoById(decoded.id);
      if (repo === undefined) return executor.select('CreateIssuePayload', { issue: null }, field);
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const labels = Array.isArray(input.labelIds) ? [] : [];
      const issue = repo.createIssue(title, body, labels, isoSeconds(0));
      return executor.select('CreateIssuePayload', { issue, repo }, field);
    },
    closeIssue: (_source, field, executor) => {
      const input = recordOf(argOf(field, 'input', executor.variables));
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const decoded = decodeGlobalId(issueId);
      if (decoded === null) return executor.select('CloseIssuePayload', { issue: null }, field);
      for (const repo of executor.store.all()) {
        const issue = repo.issues.find((entry) => entry.id === decoded.id);
        if (issue === undefined) continue;
        issue.state = 'closed';
        issue.closedAt = isoSeconds(0);
        issue.updatedAt = isoSeconds(0);
        return executor.select('CloseIssuePayload', { issue, repo }, field);
      }
      return executor.select('CloseIssuePayload', { issue: null }, field);
    },
    createPullRequest: (_source, field, executor) => {
      const input = recordOf(argOf(field, 'input', executor.variables));
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repositoryId);
      const repo = decoded === null ? undefined : executor.store.repoById(decoded.id);
      if (repo === undefined) return executor.select('CreatePullRequestPayload', { pullRequest: null }, field);
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (repo.branchTip(head) === null || repo.branchTip(base) === null) {
        return executor.select('CreatePullRequestPayload', { pullRequest: null }, field);
      }
      const pull = repo.createPull({ title, body, head, base, at: isoSeconds(0) });
      return executor.select('CreatePullRequestPayload', { pullRequest: pull, repo }, field);
    },
    mergePullRequest: (_source, field, executor) => {
      const input = recordOf(argOf(field, 'input', executor.variables));
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = decodeGlobalId(pullRequestId);
      if (decoded === null) return executor.select('MergePullRequestPayload', { pullRequest: null }, field);
      for (const repo of executor.store.all()) {
        const pull = repo.pulls.find((entry) => entry.id === decoded.id);
        if (pull === undefined) continue;
        if (!pull.merged) {
          if (repo.pullConflicts(pull)) {
            return executor.select('MergePullRequestPayload', { pullRequest: pull, repo, conflicted: true }, field);
          }
          repo.mergePull(pull, isoSeconds(0));
        }
        return executor.select('MergePullRequestPayload', { pullRequest: pull, repo }, field);
      }
      return executor.select('MergePullRequestPayload', { pullRequest: null }, field);
    },
    addComment: (_source, field, executor) => {
      const input = recordOf(argOf(field, 'input', executor.variables));
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const decoded = decodeGlobalId(subjectId);
      if (decoded === null) return executor.select('AddCommentPayload', { commentEdge: null }, field);
      for (const repo of executor.store.all()) {
        const issue = repo.issues.find((entry) => entry.id === decoded.id);
        if (issue === undefined) continue;
        const comment = repo.addComment(issue, body, isoSeconds(0));
        return executor.select('AddCommentPayload', { comment, repo }, field);
      }
      return executor.select('AddCommentPayload', { commentEdge: null }, field);
    },
  },
  __Type: {
    name: (source) => recordOf(source).name ?? null,
    kind: (source) => (TYPE_ENUMS[String(recordOf(source).name)] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (source, field) => {
      const names = TYPE_FIELDS[String(recordOf(source).name)] ?? [];
      return names.map((name) => ({ name }));
    },
    enumValues: (source) => {
      const names = TYPE_ENUMS[String(recordOf(source).name)] ?? [];
      return names.map((name) => ({ name }));
    },
  },
  User: {
    id: (source, _field, executor) => executor.globalIdOf('User', executor.store.login === String(recordOf(source).login) ? 1 : 1),
    login: (source) => recordOf(source).login ?? null,
    name: (source) => recordOf(source).login ?? null,
    email: () => null,
    avatarUrl: () => 'https://avatars.githubusercontent.com/u/1',
  },
  Repository: {
    id: (source, _field, executor) => executor.globalIdOf('Repository', repoOf(source).id),
    databaseId: (source) => repoOf(source).id,
    name: (source) => repoOf(source).name,
    nameWithOwner: (source) => repoOf(source).fullName,
    owner: (source, field, executor) => executor.select('User', { login: repoOf(source).owner }, field),
    defaultBranchRef: (source, field, executor) => {
      const repo = repoOf(source);
      if (repo.headCommit() === null) return null;
      return executor.select('Ref', { name: repo.defaultBranch, oid: repo.headCommit() }, field);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (source) => repoOf(source).description,
    isPrivate: (source) => repoOf(source).isPrivate,
    createdAt: (source) => isoSeconds(0),
    url: (source, _field, executor) => `${executor.originUrl}/${repoOf(source).fullName}`,
    stargazerCount: () => 0,
    issue: (source, field, executor) => {
      const number = argOf(field, 'number', executor.variables);
      const repo = repoOf(source);
      const issue = typeof number === 'number' ? repo.issue(number) : undefined;
      return executor.select('Issue', issue ?? null, field);
    },
    issues: (source, field, executor) => {
      const repo = repoOf(source);
      const states = statesOf(argOf(field, 'states', executor.variables));
      const orderBy = recordOf(argOf(field, 'orderBy', executor.variables));
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      const fieldName = typeof orderBy[ISSUE_ORDER_FIELD_ARG] === 'string' ? orderBy[ISSUE_ORDER_FIELD_ARG] : 'CREATED_AT';
      let items = repo.issues.filter((issue) => (states.length === 0 ? true : states.includes(issue.state.toUpperCase())));
      if (fieldName === 'UPDATED_AT') {
        items = [...items].sort((left, right) => (left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : left.number - right.number));
      } else {
        items = [...items].sort((left, right) => left.number - right.number);
      }
      if (direction !== 'ASC') items = [...items].reverse();
      const after = argOf(field, 'after', executor.variables);
      const start = indexOfCursor(typeof after === 'string' ? after : null);
      const first = pageSizeOf(argOf(field, 'first', executor.variables));
      const slice = items.slice(start, start + first);
      const end = start + slice.length;
      return executor.select('IssueConnection', { nodes: slice, repo, pageInfo: { hasNextPage: end < items.length, endCursor: slice.length === 0 ? null : cursorAt(end) } }, field);
    },
    pullRequests: (source, field, executor) => {
      const repo = repoOf(source);
      const states = statesOf(argOf(field, 'states', executor.variables));
      const wanted = states.length === 0 ? ['OPEN'] : states;
      const items = repo.pulls.filter((pull) => wanted.includes(pull.state.toUpperCase())).sort((left, right) => right.number - left.number);
      const first = pageSizeOf(argOf(field, 'first', executor.variables));
      const slice = items.slice(0, first);
      return executor.select('PullRequestConnection', { nodes: slice, repo, pageInfo: { hasNextPage: items.length > slice.length, endCursor: slice.length === 0 ? null : cursorAt(slice.length) } }, field);
    },
    pullRequest: (source, field, executor) => {
      const number = argOf(field, 'number', executor.variables);
      const repo = repoOf(source);
      const pull = typeof number === 'number' ? repo.pull(number) : undefined;
      return executor.select('PullRequest', pull === undefined ? null : { pull, repo }, field);
    },
  },
  Ref: {
    name: (source) => recordOf(source).name ?? null,
    target: (source) => ({ __typename: 'Commit', oid: recordOf(source).oid ?? null }),
  },
  Issue: {
    id: (source, _field, executor) => executor.globalIdOf('Issue', issueOf(source).id),
    number: (source) => issueOf(source).number,
    title: (source) => issueOf(source).title,
    state: (source) => issueOf(source).state.toUpperCase(),
    body: (source) => issueOf(source).body,
    createdAt: (source) => issueOf(source).createdAt,
    updatedAt: (source) => issueOf(source).updatedAt,
    closed: (source) => issueOf(source).state === 'closed',
    closedAt: (source) => issueOf(source).closedAt,
    author: (source, field, executor) => executor.select('User', { login: executor.store.login }, field),
    labels: (source) => ({ nodes: issueOf(source).labels.map((name) => ({ name })), totalCount: issueOf(source).labels.length }),
    comments: (source) => ({ totalCount: issueOf(source).comments.length, nodes: [] }),
    repository: () => null,
  },
  IssueConnection: {
    nodes: (source, field, executor) => {
      const record = recordOf(source);
      const nodes = Array.isArray(record.nodes) ? record.nodes : [];
      return nodes.map((node) => executor.select('Issue', node, field));
    },
    pageInfo: (source, field, executor) => executor.select('PageInfo', recordOf(source).pageInfo ?? null, field),
    totalCount: (source) => {
      const record = recordOf(source);
      return Array.isArray(record.nodes) ? record.nodes.length : 0;
    },
  },
  PullRequestConnection: {
    nodes: (source, field, executor) => {
      const record = recordOf(source);
      const nodes = Array.isArray(record.nodes) ? record.nodes : [];
      const repo = record.repo as Repo | undefined;
      return nodes.map((node) => executor.select('PullRequest', { pull: node, repo }, field));
    },
    pageInfo: (source, field, executor) => executor.select('PageInfo', recordOf(source).pageInfo ?? null, field),
    totalCount: (source) => {
      const record = recordOf(source);
      return Array.isArray(record.nodes) ? record.nodes.length : 0;
    },
  },
  PageInfo: {
    hasNextPage: (source) => recordOf(source).hasNextPage ?? false,
    hasPreviousPage: () => false,
    endCursor: (source) => recordOf(source).endCursor ?? null,
    startCursor: (source) => recordOf(source).startCursor ?? null,
  },
  PullRequest: {
    id: (source, _field, executor) => executor.globalIdOf('PullRequest', pullOf(recordOf(source).pull).id),
    number: (source) => pullOf(recordOf(source).pull).number,
    title: (source) => pullOf(recordOf(source).pull).title,
    state: (source) => {
      const pull = pullOf(recordOf(source).pull);
      return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
    },
    body: (source) => pullOf(recordOf(source).pull).body,
    merged: (source) => pullOf(recordOf(source).pull).merged,
    mergedAt: (source) => pullOf(recordOf(source).pull).mergedAt,
    headRefName: (source) => pullOf(recordOf(source).pull).head,
    baseRefName: (source) => pullOf(recordOf(source).pull).base,
    mergeable: (source) => {
      const record = recordOf(source);
      const repo = record.repo as Repo | undefined;
      const pull = pullOf(record.pull);
      if (repo === undefined) return 'UNKNOWN';
      if (pull.merged) return 'UNKNOWN';
      return repo.pullConflicts(pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    isDraft: () => false,
    author: (source, field, executor) => executor.select('User', { login: executor.store.login }, field),
    createdAt: (source) => pullOf(recordOf(source).pull).createdAt,
    updatedAt: (source) => pullOf(recordOf(source).pull).createdAt,
    baseRef: (source, field, executor) => {
      const record = recordOf(source);
      const repo = record.repo as Repo | undefined;
      const pull = pullOf(record.pull);
      return executor.select('Ref', { name: pull.base, oid: repo?.branchTip(pull.base) ?? null }, field);
    },
    headRef: (source, field, executor) => {
      const record = recordOf(source);
      const repo = record.repo as Repo | undefined;
      const pull = pullOf(record.pull);
      return executor.select('Ref', { name: pull.head, oid: repo?.branchTip(pull.head) ?? null }, field);
    },
    mergeCommit: () => null,
    repository: () => null,
    files: (source, field, executor) => {
      const record = recordOf(source);
      const repo = record.repo as Repo | undefined;
      const pull = pullOf(record.pull);
      const first = pageSizeOf(argOf(field, 'first', executor.variables));
      const files = pull.files.slice(0, first).map((file) => ({ file, repo: repo ?? null }));
      return executor.select(
        'PullRequestChangedFileConnection',
        { nodes: files, pageInfo: { hasNextPage: pull.files.length > files.length, endCursor: files.length === 0 ? null : cursorAt(files.length) } },
        field,
      );
    },
  },
  PullRequestChangedFileConnection: {
    nodes: (source, field, executor) => {
      const record = recordOf(source);
      const nodes = Array.isArray(record.nodes) ? record.nodes : [];
      return nodes.map((node) => executor.select('PullRequestChangedFile', node, field));
    },
    pageInfo: (source, field, executor) => executor.select('PageInfo', recordOf(source).pageInfo ?? null, field),
    totalCount: (source) => {
      const record = recordOf(source);
      return Array.isArray(record.nodes) ? record.nodes.length : 0;
    },
  },
  PullRequestChangedFile: {
    path: (source) => recordOf(recordOf(source).file).path ?? null,
    additions: (source) => recordOf(recordOf(source).file).additions ?? 0,
    deletions: (source) => recordOf(recordOf(source).file).deletions ?? 0,
    changes: (source) => {
      const file = recordOf(recordOf(source).file);
      return (Number(file.additions) || 0) + (Number(file.deletions) || 0);
    },
  },
  CreateIssuePayload: {
    issue: (source, field, executor) => executor.select('Issue', recordOf(source).issue ?? null, field),
    repository: (source, field, executor) => executor.select('Repository', recordOf(source).repo ?? null, field),
  },
  CloseIssuePayload: {
    issue: (source, field, executor) => executor.select('Issue', recordOf(source).issue ?? null, field),
  },
  CreatePullRequestPayload: {
    pullRequest: (source, field, executor) => {
      const record = recordOf(source);
      const pull = record.pullRequest;
      return executor.select('PullRequest', pull === null || pull === undefined ? null : { pull, repo: record.repo }, field);
    },
  },
  MergePullRequestPayload: {
    pullRequest: (source, field, executor) => {
      const record = recordOf(source);
      const pull = record.pullRequest;
      return executor.select('PullRequest', pull === null || pull === undefined ? null : { pull, repo: record.repo }, field);
    },
  },
  AddCommentPayload: {
    commentEdge: (source, field, executor) => {
      const record = recordOf(source);
      if (record.comment === undefined || record.comment === null) return null;
      return executor.select('IssueCommentEdge', { comment: record.comment }, field);
    },
  },
  IssueCommentEdge: {
    node: (source, field, executor) => executor.select('IssueComment', recordOf(source).comment ?? null, field),
    cursor: () => null,
  },
  IssueComment: {
    id: (source, _field, executor) => executor.globalIdOf('IssueComment', Number(recordOf(source).id) || 1),
    body: (source) => recordOf(source).body ?? null,
    author: (source, field, executor) => executor.select('User', { login: executor.store.login }, field),
    createdAt: (source) => recordOf(source).createdAt ?? null,
  },
});

// ---------------------------------------------------------------- the HTTP surface

export interface GraphQLRequest {
  method: string;
  origin: string;
  /** The bearer token, or null when the request carried none or the wrong one. */
  token: string | null;
  raw: Buffer;
}

export interface GraphQLOutcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface OperationRequest {
  query: string;
  variables: Variables;
  operationName: string | null;
}

function singleOperation(store: Store, origin: string, request: OperationRequest): unknown {
  const errors: GraphQLErrorBody[] = [];
  let operation: Operation;
  try {
    operation = new Parser(request.query).document();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'a parse error' }] };
  }
  const executor = new Executor(store, origin, request.variables);
  let data: unknown;
  if (operation.kind === 'mutation') {
    data = executor.object('Mutation', {}, operation.selections);
  } else {
    data = executor.object('Query', {}, operation.selections);
  }
  errors.push(...executor.failures());
  const body: Record<string, unknown> = { data: errors.length > 0 && data === null ? null : data };
  if (errors.length > 0) body.errors = errors;
  return body;
}

export function handleGraphQL(store: Store, request: GraphQLRequest): GraphQLOutcome {
  if (request.method !== 'POST') {
    return { status: 405, body: { message: 'Method Not Allowed' }, headers: { allow: 'POST' } };
  }
  if (request.token === null || request.token === '') {
    return { status: 401, body: { message: 'Requires authentication' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.raw.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  const batches: OperationRequest[] = [];
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      return { status: 400, body: { message: 'Problems parsing JSON' } };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    if (query === '') return { status: 400, body: { message: 'A query document is required' } };
    const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Variables) : {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    batches.push({ query, variables, operationName });
  }
  const answers = batches.map((entry) => singleOperation(store, request.origin, entry));
  return { status: 200, body: Array.isArray(parsed) ? answers : answers[0] };
}

export { parseCommit };
