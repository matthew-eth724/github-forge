// The forge's data model: repositories, their git objects and refs, issues, comments and pull
// requests. One Store instance holds every repository; the surfaces read and write it.

import { type GitObject, type ObjectType, type TreeEntry, ZERO_OID, buildCommit, buildTree, hashObject, isAncestor, parseCommit, parseTree, peelToCommit } from './gitobjects.ts';

export const DEFAULT_BRANCH = 'main';

/** The identity every REST-created commit is attributed to (fixed: no clock, no randomness). */
export const FORGE_IDENTITY = 'forge <forge@forge.invalid>';

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface PullFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  createdAt: string;
}

export class Repo {
  readonly owner: string;
  readonly name: string;
  readonly id: number;
  private descriptionText: string;
  readonly isPrivate: boolean;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, string>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  readonly createdAt: string;
  private nextIssueNumber = 1;
  private nextCommentId = 1;

  constructor(owner: string, name: string, id: number, isPrivate: boolean, description: string, createdAt: string) {
    this.owner = owner;
    this.name = name;
    this.id = id;
    this.isPrivate = isPrivate;
    this.descriptionText = description;
    this.createdAt = createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get description(): string {
    return this.descriptionText;
  }

  set description(value: string) {
    this.descriptionText = value;
  }

  get defaultBranch(): string {
    return DEFAULT_BRANCH;
  }

  // ------------------------------------------------------------ objects and refs

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store an object and answer its id. */
  put(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (a pack's objects are hashed as they are read). */
  putKnown(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }

  ref(name: string): string | null {
    return this.refs.get(name) ?? null;
  }

  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
  }

  deleteRef(name: string): void {
    this.refs.delete(name);
  }

  /** Every head branch's name and tip, sorted by name. */
  heads(): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [ref, oid] of this.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      out.push({ name: ref.slice('refs/heads/'.length), oid });
    }
    out.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return out;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit the default branch points at, or null while the repository is unborn. */
  headCommit(): string | null {
    return this.branchTip(this.defaultBranch);
  }

  // ------------------------------------------------------------ trees

  /** Every file of a commit, keyed by its full path. */
  flatten(commitOid: string | null): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    if (commitOid === null) return files;
    const commit = this.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return files;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return files;
  }

  /** The blob a commit holds at `path`, if it holds one. */
  fileAt(commitOid: string | null, path: string): { oid: string; mode: string } | null {
    return this.flatten(commitOid).get(path) ?? null;
  }

  /** Rewrite a tree with one path set to `oid` (or removed when `oid` is null); null when it empties. */
  private withPath(treeOid: string | null, segments: readonly string[], oid: string | null): string | null {
    const entries: TreeEntry[] =
      treeOid === null || this.get(treeOid) === undefined ? [] : [...parseTree(this.get(treeOid)!.data)];
    const [head, ...rest] = segments;
    if (head === undefined) return treeOid;
    if (rest.length === 0) {
      const kept = entries.filter((entry) => entry.name !== head);
      if (oid !== null) kept.push({ mode: '100644', name: head, oid });
      if (kept.length === 0) return null;
      return this.put('tree', buildTree(kept));
    }
    const existing = entries.find((entry) => entry.name === head);
    const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
    const rebuilt = this.withPath(childTree, rest, oid);
    const kept = entries.filter((entry) => entry.name !== head);
    if (rebuilt !== null) kept.push({ mode: '40000', name: head, oid: rebuilt });
    if (kept.length === 0) return null;
    return this.put('tree', buildTree(kept));
  }

  /** Commit one file write on a branch (an unborn branch gets a parentless commit). */
  writeFile(options: {
    branch: string;
    path: string;
    content: Buffer;
    message: string;
    timestamp: number;
    expectedSha?: string | undefined;
  }): { commit: string; blob: string } | 'conflict' | 'missing-branch' {
    const refName = `refs/heads/${options.branch}`;
    const parent = this.refs.get(refName) ?? null;
    if (parent === null && options.branch !== this.defaultBranch) return 'missing-branch';
    const current = this.fileAt(parent, options.path);
    if (options.expectedSha !== undefined && (current?.oid ?? '') !== options.expectedSha) return 'conflict';
    const blob = this.put('blob', options.content);
    const parentTree = parent === null ? null : parseCommit(this.get(parent)!.data).tree;
    const tree = this.withPath(parentTree, options.path.split('/').filter((segment) => segment !== ''), blob);
    if (tree === null) return 'conflict';
    const commit = this.put(
      'commit',
      buildCommit({
        tree,
        parents: parent === null ? [] : [parent],
        message: options.message,
        author: FORGE_IDENTITY,
        committer: FORGE_IDENTITY,
        timestamp: options.timestamp,
      }),
    );
    this.setRef(refName, commit);
    return { commit, blob };
  }

  /** Commit the removal of one file on a branch. */
  removeFile(options: { branch: string; path: string; message: string; timestamp: number }): { commit: string } | 'missing' | 'missing-branch' {
    const refName = `refs/heads/${options.branch}`;
    const parent = this.refs.get(refName) ?? null;
    if (parent === null) return 'missing-branch';
    if (this.fileAt(parent, options.path) === null) return 'missing';
    const parentTree = parseCommit(this.get(parent)!.data).tree;
    const tree = this.withPath(parentTree, options.path.split('/').filter((segment) => segment !== ''), null) ?? this.put('tree', buildTree([]));
    const commit = this.put(
      'commit',
      buildCommit({
        tree,
        parents: [parent],
        message: options.message,
        author: FORGE_IDENTITY,
        committer: FORGE_IDENTITY,
        timestamp: options.timestamp,
      }),
    );
    this.setRef(refName, commit);
    return { commit };
  }

  /** The commits reachable from `start`, newest first. */
  commitLog(start: string | null, limit = 200): Array<{ oid: string; view: ReturnType<typeof parseCommit> }> {
    const out: Array<{ oid: string; view: ReturnType<typeof parseCommit> }> = [];
    if (start === null) return out;
    const seen = new Set<string>();
    const queue: string[] = [start];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      out.push({ oid, view });
      for (const parent of view.parents) queue.push(parent);
    }
    return out;
  }

  /** The nearest commit reachable from both tips, or null. */
  mergeBase(left: string, right: string): string | null {
    const rightReach = new Set<string>();
    const queue = [right];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (rightReach.has(oid)) continue;
      rightReach.add(oid);
      const object = this.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const seen = new Set<string>();
    const leftQueue = [left];
    while (leftQueue.length > 0) {
      const oid = leftQueue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (rightReach.has(oid)) return oid;
      const object = this.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) leftQueue.push(parent);
    }
    return null;
  }

  // ------------------------------------------------------------ issues and pulls

  createIssue(title: string, body: string, labels: readonly string[], at: string): Issue {
    const number = this.nextIssueNumber;
    this.nextIssueNumber += 1;
    const issue: Issue = {
      number,
      id: this.id * 1000 + number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      comments: [],
    };
    this.issues.push(issue);
    return issue;
  }

  issue(number: number): Issue | undefined {
    return this.issues.find((entry) => entry.number === number);
  }

  addComment(issue: Issue, body: string, at: string): Comment {
    const comment: Comment = { id: this.nextCommentId, body, user: this.owner, createdAt: at };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(fields: { title: string; body: string; head: string; base: string; at: string }): Pull {
    const number = this.nextIssueNumber;
    this.nextIssueNumber += 1;
    const headSha = this.branchTip(fields.head) ?? ZERO_OID;
    const baseSha = this.branchTip(fields.base) ?? ZERO_OID;
    const pull: Pull = {
      number,
      id: this.id * 10_000 + number,
      title: fields.title,
      body: fields.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: fields.head,
      base: fields.base,
      headSha,
      baseSha,
      files: this.diffFiles(this.mergeBaseOr(baseSha, headSha), headSha),
      createdAt: fields.at,
    };
    this.pulls.push(pull);
    return pull;
  }

  pull(number: number): Pull | undefined {
    return this.pulls.find((entry) => entry.number === number);
  }

  private mergeBaseOr(baseSha: string, headSha: string): string | null {
    if (baseSha === ZERO_OID || headSha === ZERO_OID) return null;
    return this.mergeBase(baseSha, headSha);
  }

  /** The changed files between two commits. */
  diffFiles(baseCommit: string | null, headCommit: string | null): PullFile[] {
    const before = this.flatten(baseCommit);
    const after = this.flatten(headCommit);
    const files: PullFile[] = [];
    for (const [path, entry] of after) {
      const old = before.get(path);
      if (old !== undefined && old.oid === entry.oid) continue;
      const added = countLines(this.get(entry.oid)?.data);
      const removed = old === undefined ? 0 : countLines(this.get(old.oid)?.data);
      files.push({
        path,
        status: old === undefined ? 'added' : 'modified',
        additions: Math.max(1, added - removed > 0 ? added - removed : 1),
        deletions: old === undefined ? 0 : Math.max(0, removed - added),
      });
    }
    for (const [path, entry] of before) {
      if (after.has(path)) continue;
      files.push({ path, status: 'removed', additions: 0, deletions: Math.max(1, countLines(this.get(entry.oid)?.data)) });
    }
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return files;
  }

  /** Whether merging `pull` into its base conflicts: both sides changed one path differently. */
  pullConflicts(pull: Pull): boolean {
    const baseTip = this.branchTip(pull.base);
    if (baseTip === null) return false;
    const headTip = this.branchTip(pull.head);
    if (headTip === null) return true;
    const base = this.mergeBase(baseTip, headTip);
    const baseFiles = this.flatten(base);
    const baseSide = this.flatten(baseTip);
    const headSide = this.flatten(headTip);
    for (const [path, entry] of headSide) {
      const original = baseFiles.get(path);
      const current = baseSide.get(path);
      if (original !== undefined && original.oid === entry.oid) continue;
      if (current === undefined) {
        if (original !== undefined) return true;
        continue;
      }
      if (original === undefined) return true;
      if (current.oid !== original.oid && entry.oid !== original.oid && current.oid !== entry.oid) return true;
    }
    for (const [path, entry] of baseFiles) {
      if (headSide.has(path)) continue;
      const current = baseSide.get(path);
      if (current !== undefined && current.oid !== entry.oid) return true;
    }
    return false;
  }

  /** Squash-merge a pull onto its base branch; null when a branch is gone. */
  mergePull(pull: Pull, at: string): { commit: string } | null {
    const baseTip = this.branchTip(pull.base);
    const headTip = this.branchTip(pull.head);
    if (baseTip === null || headTip === null) return null;
    const base = this.mergeBase(baseTip, headTip);
    const baseFiles = this.flatten(base);
    const baseSide = this.flatten(baseTip);
    const headSide = this.flatten(headTip);
    const merged = new Map<string, { oid: string; mode: string }>(baseSide);
    for (const [path, entry] of headSide) {
      const original = baseFiles.get(path);
      const current = baseSide.get(path);
      if (original !== undefined && original.oid === entry.oid) continue;
      if (current !== undefined && original !== undefined && current.oid !== original.oid && current.oid !== entry.oid) continue;
      merged.set(path, entry);
    }
    for (const [path, entry] of baseFiles) {
      if (headSide.has(path)) continue;
      const current = baseSide.get(path);
      if (current !== undefined && current.oid === entry.oid) merged.delete(path);
    }
    const tree = this.treeFromFiles(merged);
    const commit = this.put(
      'commit',
      buildCommit({
        tree,
        parents: [baseTip],
        message: `${pull.title} (#${pull.number})\n`,
        author: FORGE_IDENTITY,
        committer: FORGE_IDENTITY,
        timestamp: 1_735_689_600,
      }),
    );
    this.setRef(`refs/heads/${pull.base}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = at;
    pull.mergeCommitSha = commit;
    pull.files = this.diffFiles(base, headTip);
    return { commit };
  }

  /** Build a tree object from a flat path map. */
  treeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/').filter((segment) => segment !== '');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode === '100755' ? '100755' : '100644', name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Every object reachable from the given tips (commits, their trees, and their blobs and tags). */
  reachable(tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const visit = (oid: string): void => {
      if (seen.has(oid)) return;
      const object = this.get(oid);
      if (object === undefined) return;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        visit(view.tree);
        for (const parent of view.parents) visit(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '40000') visit(entry.oid);
          else seen.add(entry.oid);
        }
      } else if (object.type === 'tag') {
        const view = parseTagOf(object.data);
        if (view !== null) visit(view);
      }
    };
    for (const tip of tips) visit(tip);
    return seen;
  }

  /** Whether `ancestor` is reachable from `descendant` through commit parents. */
  isAncestor(ancestor: string, descendant: string): boolean {
    return isAncestor(ancestor, descendant, (oid) => this.get(oid));
  }
}

function countLines(data: Buffer | undefined): number {
  if (data === undefined) return 0;
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

function parseTagOf(data: Buffer): string | null {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) return line.slice(7);
  }
  return null;
}

/** The whole forge: repositories by `owner/name`, plus the counters behind numeric ids. */
export class Store {
  private readonly repos = new Map<string, Repo>();
  private readonly byId = new Map<number, Repo>();
  private nextRepoId = 1_000_001;
  private clock = 0;
  /** The login the bearer token names; the owner of every repository this forge creates. */
  readonly login: string;

  constructor(login: string) {
    this.login = login;
  }

  /** The next deterministic timestamp (never a clock read). */
  now(): string {
    this.clock += 1;
    return isoSeconds(this.clock);
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
  }

  repoById(id: number): Repo | undefined {
    return this.byId.get(id);
  }

  all(): Repo[] {
    return [...this.repos.values()];
  }

  ownedBy(login: string): Repo[] {
    return this.all().filter((repo) => repo.owner === login);
  }

  create(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo(owner, name, this.nextRepoId, isPrivate, description, this.now());
    this.nextRepoId += 1;
    this.repos.set(`${owner.toLowerCase()}/${name.toLowerCase()}`, repo);
    this.byId.set(repo.id, repo);
    return repo;
  }

  remove(repo: Repo): void {
    this.repos.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`);
    this.byId.delete(repo.id);
  }

  /** Peel an id to a commit (tags are followed). */
  peel(oid: string, repo: Repo): string | null {
    return peelToCommit(oid, (id) => repo.get(id));
  }
}

/** An ISO-8601 timestamp `seconds` after a fixed epoch, computed without a Date. */
export function isoSeconds(seconds: number): string {
  const total = 1_735_689_600 + seconds;
  const days = Math.floor(total / 86_400);
  const rest = total - days * 86_400;
  const hour = Math.floor(rest / 3600);
  const minute = Math.floor((rest - hour * 3600) / 60);
  const second = rest - hour * 3600 - minute * 60;
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
