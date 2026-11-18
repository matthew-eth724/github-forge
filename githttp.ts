// Git's smart HTTP transport: the two advertisements and the two POST services, over the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { DELIM, FLUSH, RESPONSE_END, decodePktLinePrefix, pktLine, pktText, readStream } from './pktline.ts';
import { type GitObject, ZERO_OID, parseCommit, parseTag, parseTree, peelToCommit, readPack, writePack } from './gitobjects.ts';
import type { Repo } from './store.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

const AGENT = 'forge/1.0';

const UPLOAD_PACK_V0_CAPS = ['multi_ack_detailed', 'multi_ack', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', `agent=${AGENT}`];
const RECEIVE_PACK_CAPS = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];

/** The largest sideband payload this server sends: one band byte plus data, under git's pkt cap. */
const SIDEBAND_CHUNK = 32_000;

/** Answer a missing repository with a plain 404, which both services' clients accept. */
export function notFound(res: ServerResponse): void {
  const body = 'repository not found\n';
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function smartHeaders(res: ServerResponse, contentType: string, bytes: number): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(bytes),
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  });
}

function writeBytes(res: ServerResponse, contentType: string, body: Buffer): void {
  smartHeaders(res, contentType, body.length);
  res.end(body);
}

/** Wrap payloads as band-1 (data) sideband packets, split so no packet passes git's cap. */
function sideband(chunks: readonly Buffer[]): Buffer[] {
  const out: Buffer[] = [];
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; offset += SIDEBAND_CHUNK) {
      const slice = chunk.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, chunk.length));
      out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  return out;
}

// ---------------------------------------------------------------- advertisements

/** The refs a v0 advertisement lists, HEAD first with its symref. */
function advertRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  const head = repo.headCommit();
  if (head !== null) out.push({ oid: head, name: 'HEAD' });
  for (const [name, oid] of sortedRefs(repo)) out.push({ oid, name });
  return out;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const ref of repo.refs.keys()) if (ref.startsWith('refs/')) out.push([ref, repo.refs.get(ref)!]);
  out.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return out;
}

/** `GET <repo>/info/refs?service=...` */
export function serveInfoRefs(repo: Repo, service: GitService, wantsV2: boolean, res: ServerResponse): void {
  const preamble = pktLine(`# service=${service}\n`);
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantsV2) {
    const caps = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow filter',
      'object-format=sha1',
      'server-option',
    ];
    const body = Buffer.concat([preamble, FLUSH, ...caps.map((cap) => pktLine(`${cap}\n`)), FLUSH]);
    writeBytes(res, contentType, body);
    return;
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_PACK_V0_CAPS : RECEIVE_PACK_CAPS;
  const extra = service === 'git-upload-pack' ? [`symref=HEAD:refs/heads/${repo.defaultBranch}`] : [];
  const capabilityText = [...caps, ...extra].join(' ');
  const lines: Buffer[] = [];
  const refs = advertRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilityText}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${capabilityText}` : '';
      lines.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    });
  }
  // Peel annotated tags, the way git's advertisement does.
  const peeled: Buffer[] = [];
  for (const [name, oid] of sortedRefs(repo)) {
    if (!name.startsWith('refs/tags/')) continue;
    const object = repo.get(oid);
    if (object === undefined || object.type !== 'tag') continue;
    const commit = peelToCommit(oid, (id) => repo.get(id));
    if (commit !== null) peeled.push(pktLine(`${commit} ${name}^{}\n`));
  }
  const body = Buffer.concat([preamble, FLUSH, ...lines, ...peeled, FLUSH]);
  writeBytes(res, contentType, body);
}

// ---------------------------------------------------------------- v2 ls-refs

function serveLsRefs(repo: Repo, args: readonly string[], res: ServerResponse): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const head = repo.headCommit();
  if (keep('HEAD')) {
    if (head === null) {
      if (unborn) lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else {
      lines.push(pktLine(`${head} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const object = repo.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const commit = peelToCommit(oid, (id) => repo.get(id));
        if (commit !== null) line += ` peeled:${commit}`;
      }
    }
    lines.push(pktLine(`${line}\n`));
  }
  writeBytes(res, 'application/x-git-upload-pack-result', Buffer.concat([...lines, FLUSH]));
}

// ---------------------------------------------------------------- v2 fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
  filter: string | null;
  thinPack: boolean;
  noProgress: boolean;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const parsed: FetchArgs = {
    wants: [],
    haves: [],
    shallows: [],
    depth: null,
    filter: null,
    thinPack: false,
    noProgress: false,
  };
  for (const arg of args) {
    if (arg === 'thin-pack') parsed.thinPack = true;
    else if (arg === 'no-progress') parsed.noProgress = true;
    else if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallows.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.depth = Math.max(0, Number.parseInt(arg.slice(7).trim(), 10) || 0);
    else if (arg.startsWith('filter ')) parsed.filter = arg.slice(7).trim();
    // deepen-since, deepen-not, ofs-delta, wait-for-done, include-tag, done: nothing to do.
  }
  return parsed;
}

/**
 * The object graph a fetch should send: objects reachable from the wants, minus those the client's
 * haves already reach, cut at `depth` generations when the request asks for a shallow fetch.
 */
function planFetch(repo: Repo, request: FetchArgs): { objects: string[]; shallow: string[]; unshallow: string[] } {
  const wantCommits = new Set<string>();
  const shallowBoundary = new Set<string>();
  const commitOrder: string[] = [];
  if (request.depth === null) {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const want of request.wants) queue.push(want);
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.get(oid);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        const view = parseTag(object.data);
        queue.push(view.object);
        continue;
      }
      if (object.type !== 'commit') continue;
      wantCommits.add(oid);
      commitOrder.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  } else {
    // Generation counting from the wants: generation 1 is the want itself.
    const generation = new Map<string, number>();
    let frontier: string[] = [];
    for (const want of request.wants) {
      const object = repo.get(want);
      const commit = object === undefined ? null : object.type === 'commit' ? want : peelToCommit(want, (id) => repo.get(id));
      if (commit !== null && !generation.has(commit)) {
        generation.set(commit, 1);
        frontier.push(commit);
      }
    }
    let depth = 1;
    while (frontier.length > 0 && depth <= request.depth) {
      const next: string[] = [];
      for (const oid of frontier) {
        wantCommits.add(oid);
        commitOrder.push(oid);
        if (depth === request.depth) {
          shallowBoundary.add(oid);
          continue;
        }
        const object = repo.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          if (generation.has(parent)) continue;
          generation.set(parent, depth + 1);
          next.push(parent);
        }
      }
      frontier = next;
      depth += 1;
    }
  }

  const wantObjects: string[] = [];
  for (const want of request.wants) {
    const object = repo.get(want);
    // An annotated tag is delivered as itself: the client asked for the tag ref, not only its commit.
    if (object !== undefined && object.type === 'tag' && !wantObjects.includes(want)) wantObjects.push(want);
  }

  // Everything the client already holds, as whole objects. A shallow client holds no history past the
  // boundaries it names, so the walk stops at them.
  const shallowOfClient = new Set(request.shallows);
  const held = new Set<string>();
  const heldCommits = new Set<string>();
  const visitHeld = (oid: string): void => {
    if (held.has(oid)) return;
    const object = repo.get(oid);
    if (object === undefined) return;
    held.add(oid);
    if (object.type === 'commit') {
      heldCommits.add(oid);
      const view = parseCommit(object.data);
      visitHeld(view.tree);
      if (shallowOfClient.has(oid)) return;
      for (const parent of view.parents) visitHeld(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visitHeld(entry.oid);
    }
  };
  for (const have of request.haves) visitHeld(have);

  const skipBlobs = request.filter === 'blob:none';
  const skipTrees = request.filter === 'tree:0';
  const objects: string[] = [];
  const added = new Set<string>();
  const addObject = (oid: string): void => {
    if (added.has(oid) || held.has(oid)) return;
    const object = repo.get(oid);
    if (object === undefined) return;
    if (skipBlobs && object.type === 'blob') return;
    if (skipTrees && (object.type === 'tree' || object.type === 'blob')) return;
    added.add(oid);
    objects.push(oid);
  };
  const addTree = (treeOid: string): void => {
    if (!skipTrees) addObject(treeOid);
    const tree = repo.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else addObject(entry.oid);
    }
  };
  const addCommit = (oid: string): void => {
    addObject(oid);
    const commit = repo.get(oid);
    if (commit === undefined || commit.type !== 'commit') return;
    addTree(parseCommit(commit.data).tree);
  };
  for (const oid of wantObjects) addObject(oid);
  for (const oid of commitOrder) addCommit(oid);

  const unshallow: string[] = [];
  for (const boundary of request.shallows) {
    if (shallowBoundary.has(boundary)) continue;
    const isCommit = repo.get(boundary)?.type === 'commit';
    if (!isCommit) continue;
    if (request.depth === null) unshallow.push(boundary);
    else {
      // A boundary the client had is lifted once we deliver the generation below it.
      const stillShallow = shallowBoundary.has(boundary);
      if (!stillShallow && wantCommits.has(boundary)) unshallow.push(boundary);
    }
  }
  return { objects, shallow: [...shallowBoundary], unshallow };
}

function serveFetchV2(repo: Repo, args: readonly string[], res: ServerResponse): void {
  const request = parseFetchArgs(args);
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  const shallowLines: Buffer[] = [];
  for (const oid of plan.shallow) shallowLines.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) shallowLines.push(pktLine(`unshallow ${oid}\n`));
  if (shallowLines.length > 0) parts.push(pktLine('shallow-info\n'), ...shallowLines, DELIM);

  if (plan.objects.length === 0) {
    parts.push(FLUSH);
    writeBytes(res, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  const payloads: GitObject[] = [];
  for (const oid of plan.objects) {
    const object = repo.get(oid);
    if (object !== undefined) payloads.push(object);
  }
  const pack = writePack(payloads);
  parts.push(pktLine('packfile\n'), ...sideband([pack]), FLUSH);
  writeBytes(res, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- v0 fetch

function serveFetchV0(repo: Repo, lines: readonly string[], res: ServerResponse): void {
  const request = parseFetchArgs(lines);
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (request.haves.length === 0) parts.push(pktLine('NAK\n'));
  else {
    const known = request.haves.find((oid) => repo.has(oid));
    parts.push(pktLine(known === undefined ? 'NAK\n' : `ACK ${known}\n`));
  }
  if (plan.objects.length > 0) {
    const payloads: GitObject[] = [];
    for (const oid of plan.objects) {
      const object = repo.get(oid);
      if (object !== undefined) payloads.push(object);
    }
    parts.push(...sideband([writePack(payloads)]));
  }
  parts.push(FLUSH);
  writeBytes(res, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into its command list and the pack that follows it. */
function splitReceivePack(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer } {
  const prefix = decodePktLinePrefix(body);
  const commands: PushCommand[] = [];
  const capabilities: string[] = [];
  for (const packet of prefix.packets) {
    if (packet.payload === null) continue;
    let line = packet.payload.toString('utf8').replace(/\n$/u, '');
    if (line === '') continue;
    if (commands.length === 0) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        capabilities.push(...line.slice(nul + 1).split(' ').filter((token) => token !== ''));
        line = line.slice(0, nul);
      }
    }
    const [oldOid, newOid, ...rest] = line.split(' ');
    if (oldOid === undefined || newOid === undefined || rest.length === 0) throw new Error(`bad receive-pack command ${JSON.stringify(line)}`);
    commands.push({ oldOid, newOid, ref: rest.join(' ') });
  }
  if (commands.length === 0) throw new Error('a receive-pack request carried no commands');
  return { commands, capabilities, pack: body.subarray(prefix.consumed) };
}

function reportLine(ref: string, ok: boolean, reason: string): string {
  return ok ? `ok ${ref}\n` : `ng ${ref} ${reason}\n`;
}

function serveReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { commands, capabilities, pack } = splitReceivePack(body);
  const banded = capabilities.includes('side-band-64k');
  const wantsReport = capabilities.some((capability) => capability === 'report-status' || capability === 'report-status-v2');

  let unpackOk = true;
  if (pack.length >= 12) {
    try {
      const read = readPack(pack, (oid) => repo.get(oid));
      for (const [oid, object] of read.objects) repo.putKnown(oid, object);
    } catch {
      unpackOk = false;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  } else {
    for (const command of commands) results.push(applyPush(repo, command));
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  for (const result of results) reportLines.push(reportLine(result.ref, result.ok, result.reason));
  const report = wantsReport ? Buffer.concat([...reportLines.map((line) => pktLine(line)), FLUSH]) : Buffer.alloc(0);

  const parts: Buffer[] = [];
  if (banded) {
    if (report.length > 0) parts.push(...sideband([report]));
    parts.push(FLUSH);
  } else if (report.length > 0) {
    parts.push(report);
  }
  writeBytes(res, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}

/** Apply one ref command; the reason string is what report-status says on a refusal. */
function applyPush(repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  if (!/^refs\//u.test(command.ref)) return { ref: command.ref, ok: false, reason: 'funny refname' };
  if (command.newOid !== ZERO_OID && !/^[0-9a-f]{40}$/u.test(command.newOid)) {
    return { ref: command.ref, ok: false, reason: 'bad new object id' };
  }
  const current = repo.ref(command.ref);
  const deleting = command.newOid === ZERO_OID;
  if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
    return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  }
  if (command.oldOid === ZERO_OID && current !== null && !deleting) {
    return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  }
  if (deleting) {
    if (current === null) return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
    repo.deleteRef(command.ref);
    return { ref: command.ref, ok: true, reason: '' };
  }
  if (!repo.has(command.newOid)) return { ref: command.ref, ok: false, reason: 'missing necessary objects' };
  if (current !== null && command.ref.startsWith('refs/heads/')) {
    if (!repo.isAncestor(current, command.newOid)) {
      return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.setRef(command.ref, command.newOid);
  return { ref: command.ref, ok: true, reason: '' };
}

// ---------------------------------------------------------------- dispatch

/**
 * Serve a POST to one of the two services. `decoded` is a whole pkt-line stream for upload-pack
 * (v2 commands or a v0 want list) and a command list plus pack for receive-pack.
 */
export function serveService(repo: Repo, service: GitService, body: Buffer, wantsV2: boolean, res: ServerResponse): void {
  if (service === 'git-receive-pack') {
    serveReceivePack(repo, body, res);
    return;
  }
  const prefix = decodePktLinePrefix(body);
  const lines = pktText(prefix.packets);
  if (lines.length === 0) {
    writeBytes(res, 'application/x-git-upload-pack-result', FLUSH);
    return;
  }
  const command = lines[0];
  if (command === 'command=ls-refs') {
    const delimIndex = prefix.packets.findIndex((packet) => packet.kind === 'delim');
    const args = delimIndex < 0 ? [] : prefix.packets.slice(delimIndex + 1).filter((packet) => packet.payload !== null).map((packet) => packet.payload!.toString('utf8').replace(/\n$/u, ''));
    serveLsRefs(repo, args, res);
    return;
  }
  if (command === 'command=fetch') {
    const delimIndex = prefix.packets.findIndex((packet) => packet.kind === 'delim');
    const args =
      delimIndex < 0
        ? []
        : prefix.packets
            .slice(delimIndex + 1)
            .filter((packet) => packet.payload !== null)
            .map((packet) => packet.payload!.toString('utf8').replace(/\n$/u, ''));
    serveFetchV2(repo, args, res);
    return;
  }
  if (command.startsWith('command=')) {
    writeBytes(res, 'application/x-git-upload-pack-result', Buffer.concat([pktLine('ERR unknown v2 command\n'), FLUSH]));
    return;
  }
  // No `command=` line: a v0 want/have exchange.
  void wantsV2;
  serveFetchV0(repo, lines, res);
}

export { RESPONSE_END, readStream };
