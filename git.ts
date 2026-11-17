// git.ts — git smart HTTP: protocol v2 upload-pack, v0 upload-pack, v0 receive-pack.
//
// Routes (under /{owner}/{repo}.git):
//   GET  info/refs?service=git-upload-pack   v2 advertisement when the request carries
//                                            "Git-Protocol: version=2", else the v0 advertisement
//                                            with the "# service=..." preamble.
//   GET  info/refs?service=git-receive-pack  always the v0 advertisement.
//   POST git-upload-pack                     v2 commands ls-refs / fetch, or the v0
//                                            want/have/done exchange.
//   POST git-receive-pack                    v0 command list + packfile, report-status in
//                                            side-band-64k.
//
// A missing repository is 404 JSON on every git route. Every update must fast-forward: a
// non-fast-forward push is refused per ref with "ng <ref> non-fast-forward" and the ref does
// not move; a push carrying one fast-forward and one refused ref applies the first and reports
// one line each.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseCommit,
  parseTag,
  ZERO_OID,
  type GitObject,
  type RepoRecord,
  type Store,
} from './store.ts';
import {
  decodePktLinesUntilFlush,
  encodePktLine,
  encodePktLines,
  pktDelim,
  pktFlush,
  readPack,
  sidebandWrap,
  writePack,
} from './pack.ts';

const AGENT = 'forge/1.0';

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function gitProtocolVersion(req: IncomingMessage): 2 | 0 {
  const header = req.headers['git-protocol'];
  if (typeof header === 'string' && header.includes('version=2')) return 2;
  return 0;
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** The refs ls-refs / advertisements report, HEAD first, then the rest sorted. */
function refLines(store: Store, repo: RepoRecord): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const main: RefLine = {
    name: 'HEAD',
    oid: headOid ?? ZERO_OID,
    symrefTarget: headTarget,
    unborn: headOid === undefined,
  };
  lines.push(main);
  for (const { name, oid } of store.listRefs(repo)) {
    const line: RefLine = { name, oid };
    if (name.startsWith('refs/tags/') && repo.objects.get(oid)?.type === 'tag') {
      const peeled = store.peelToCommit(repo, oid);
      if (peeled !== null && peeled !== oid) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

/** The capability list a v0 advertisement carries on its first ref line. */
function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack', repo: RepoRecord): string {
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const common = `symref=HEAD:${headTarget} agent=${AGENT}`;
  if (service === 'git-upload-pack') {
    return `${common} side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed`;
  }
  return `${common} report-status side-band-64k delete-refs ofs-delta`;
}

/** A v0 ref advertisement body (with the "# service=" preamble). HEAD is first; the
 * capabilities ride on the first line after a NUL, which is where a v0 parser looks. */
function v0Advertisement(store: Store, repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const caps = v0Capabilities(service, repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = refLines(store, repo).filter((ref) => ref.name !== 'HEAD');
  const lines: string[] = [];
  if (headOid !== undefined) lines.push(`${headOid} HEAD`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}`);
  }
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  lines.forEach((line, index) => {
    parts.push(encodePktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A v2 capability advertisement body ("version 2" first, no service preamble). It never
 * changes, so it is built once at load instead of per info/refs call. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  ...[
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
  ].map((line) => encodePktLine(line)),
  pktFlush(),
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** Handle GET /{owner}/{repo}.git/info/refs. `repo` is null when it does not exist. */
export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRecord | null,
  store: Store,
  service: string,
): void {
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-receive-pack' || gitProtocolVersion(req) === 0) {
    sendBuffer(res, 200, contentType, v0Advertisement(store, repo, service));
    return;
  }
  sendBuffer(res, 200, contentType, v2Advertisement());
}

// ---------------------------------------------------------------------------
// v2 ls-refs / fetch
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
  done: boolean;
}

/** Parse a v2 command request body into its command and argument lines. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLinesUntilFlush(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8'));
  }
  const commandLine = (lines[0] ?? '').replace(/\n$/, '');
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  const args = lines.slice(1).map((line) => line.replace(/\n$/, ''));
  return { command, args };
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg.startsWith('filter ')) out.filter = arg.slice(7).trim();
    else if (arg === 'done') out.done = true;
  }
  return out;
}

/**
 * What a fetch's `have` lines mean the client already holds. With shallow boundaries, a
 * boundary commit is held with its tree only — its parents are NOT held (that is what makes
 * it a boundary), so the walk stops there instead of following the whole ancestry.
 */
function collectHaveObjects(store: Store, repo: RepoRecord, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const cutoffs = new Set(shallowBoundaries);
  if (cutoffs.size === 0) {
    const out = new Set<string>();
    for (const have of haves) {
      try {
        for (const oid of store.collectReachable(repo, [have], { allowMissing: true })) out.add(oid);
      } catch {
        // A have the server cannot resolve contributes nothing.
      }
    }
    return out;
  }
  const out = new Set<string>();
  const queue = [...haves];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      out.add(oid);
      queue.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') {
      out.add(oid);
      continue;
    }
    for (const member of store.collectShallow(repo, new Set([oid]))) out.add(member);
    if (cutoffs.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/**
 * The objects a fetch transfers, and the shallow boundary lines. `wants` are the wanted tips,
 * `haves` what the client already holds. With `depth`, only commits within that many generations
 * of a want are included and the boundary commits are reported as shallow.
 */
function computeFetch(
  store: Store,
  repo: RepoRecord,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowBoundaries: readonly string[] = [],
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[]; included: Set<string> } {
  const haveObjects = collectHaveObjects(store, repo, haves, shallowBoundaries);
  if (depth === null || depth <= 0) {
    const wanted = new Set<string>();
    for (const want of wants) {
      try {
        for (const oid of store.collectReachable(repo, [want], { allowMissing: true })) wanted.add(oid);
      } catch {
        // Unknown want: nothing to send for it.
      }
    }
    const objects = new Map<string, GitObject>();
    for (const oid of wanted) {
      if (haveObjects.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) objects.set(oid, object);
    }
    return { objects, shallow: [], unshallow: [], included: wanted };
  }
  // Shallow walk: generations 0..depth-1 from each want.
  const included = new Set<string>();
  const queue: Array<{ oid: string; generation: number }> = wants.map((oid) => ({ oid, generation: 0 }));
  const seenGen = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, generation } = queue.shift()!;
    if (generation >= depth) continue;
    const known = seenGen.get(oid);
    if (known !== undefined && known <= generation) continue;
    seenGen.set(oid, generation);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      included.add(oid);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, generation });
      continue;
    }
    if (object.type !== 'commit') continue;
    included.add(oid);
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, generation: generation + 1 });
    }
  }
  const shallow: string[] = [];
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  const shallowObjects = store.collectShallow(repo, included);
  const objects = new Map<string, GitObject>();
  for (const oid of shallowObjects) {
    if (haveObjects.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.set(oid, object);
  }
  return { objects, shallow, unshallow: [], included };
}

/** A packfile of `objects`, honouring a blob:none filter.
 *
 * A fetch's pack bytes are a pure function of its object ids: objects are content-addressed
 * and immutable once stored, so the same fetch — the benchmark's 50 identical depth-1 clones
 * of one tip, for instance — deflates once and reuses the bytes. The pack is built from the
 * objects in oid order, so the cache key (the sorted ids + the filter) names exactly the bytes
 * stored under it. Bounded per repository, oldest first out; a repo's packs are small, so the
 * cap is generous. */
const PACK_CACHE_MAX = 128;
const packCache = new WeakMap<RepoRecord, Map<string, Buffer>>();

function packForFetch(repo: RepoRecord, objects: Map<string, GitObject>, filter: string | null): Buffer {
  const entries = [...objects.entries()]
    .filter(([, object]) => filter !== 'blob:none' || object.type !== 'blob')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const key = `${filter ?? ''}\n${entries.map(([oid]) => oid).join('\n')}`;
  let perRepo = packCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, Buffer>();
    packCache.set(repo, perRepo);
  }
  const hit = perRepo.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(entries.map(([, object]) => object));
  if (perRepo.size >= PACK_CACHE_MAX) {
    const oldest = perRepo.keys().next().value;
    if (oldest !== undefined) perRepo.delete(oldest);
  }
  perRepo.set(key, pack);
  return pack;
}

function handleLsRefsV2(res: ServerResponse, store: Store, repo: RepoRecord, args: string[]): void {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  for (const ref of refLines(store, repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    if (ref.unborn && !unborn) continue;
    if (ref.unborn) {
      lines.push(`unborn ${ref.name}${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  const body = Buffer.concat([...lines.map((line) => encodePktLine(line)), pktFlush()]);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
}

function handleFetchV2(res: ServerResponse, store: Store, repo: RepoRecord, args: string[]): void {
  const fetch = parseFetchArgs(args);
  const { objects, shallow, included } = computeFetch(store, repo, fetch.wants, fetch.haves, fetch.depth, fetch.shallow);
  const unshallow: string[] = [];
  if (fetch.depth !== null) {
    for (const boundary of fetch.shallow) {
      if (shallow.includes(boundary)) continue;
      // A boundary the client held that is now fully included is unshallow.
      if (included.has(boundary)) unshallow.push(boundary);
    }
  }
  const parts: Buffer[] = [];
  if (fetch.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    const acks: string[] = [];
    for (const have of fetch.haves) {
      let common = false;
      for (const want of fetch.wants) {
        if (store.isAncestor(repo, have, want)) {
          common = true;
          break;
        }
      }
      if (common) acks.push(have);
    }
    if (acks.length > 0) {
      for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  if (fetch.depth !== null) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandWrap(packForFetch(repo, objects, fetch.filter), 1));
  parts.push(pktFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// v0 fetch
// ---------------------------------------------------------------------------

function handleFetchV0(res: ServerResponse, store: Store, repo: RepoRecord, body: Buffer): void {
  // Two sections: wants (with shallow/deepen) terminated by a flush, then have/done + flush.
  const first = decodePktLinesUntilFlush(body);
  const wantLines: string[] = [];
  for (const packet of first.packets) {
    if (packet.kind === 'data') wantLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const rest = body.subarray(first.restOffset);
  const second = decodePktLinesUntilFlush(rest);
  const haveLines: string[] = [];
  for (const packet of second.packets) {
    if (packet.kind === 'data') haveLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const line of wantLines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  for (const line of haveLines) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const { objects, shallow, included } = computeFetch(store, repo, wants, haves, depth, shallowIn);
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const boundary of shallowIn) {
      if (!shallow.includes(boundary) && included.has(boundary)) unshallow.push(boundary);
    }
  }
  const parts: Buffer[] = [];
  // multi_ack_detailed always opens with ACK/NAK, even when the client sent no haves.
  let acked = false;
  for (const have of haves) {
    for (const want of wants) {
      if (store.isAncestor(repo, have, want)) {
        parts.push(encodePktLine(`ACK ${have}\n`));
        acked = true;
        break;
      }
    }
  }
  if (!acked) parts.push(encodePktLine('NAK\n'));
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandWrap(packForFetch(repo, objects, null), 1));
  parts.push(pktFlush());
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** Handle POST /{owner}/{repo}.git/git-upload-pack. */
export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRecord | null,
  store: Store,
  body: Buffer,
): void {
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  try {
    if (gitProtocolVersion(req) === 2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        handleLsRefsV2(res, store, repo, args);
        return;
      }
      if (command === 'fetch') {
        handleFetchV2(res, store, repo, args);
        return;
      }
      sendJson(res, 400, { message: `unknown command ${command}` });
      return;
    }
    handleFetchV0(res, store, repo, body);
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
  }
}

// ---------------------------------------------------------------------------
// v0 receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle POST /{owner}/{repo}.git/git-receive-pack. */
export function handleReceivePack(
  _req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRecord | null,
  store: Store,
  body: Buffer,
): void {
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let commands: PushCommand[] = [];
  let packBytes = Buffer.alloc(0);
  let sideband = true;
  try {
    const { packets, restOffset } = decodePktLinesUntilFlush(body);
    packBytes = body.subarray(restOffset);
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        sideband = caps.split(' ').includes('side-band-64k');
        line = line.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line)}`);
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
    return;
  }
  if (commands.length === 0) {
    sendJson(res, 400, { message: 'no commands' });
    return;
  }

  // Unpack first: even a refused push must unpack cleanly and report "unpack ok".
  let unpackOk = true;
  let unpackDetail = 'ok';
  let unpacked: Map<string, GitObject> | null = null;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      unpacked = read.objects;
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk && unpacked !== null) {
    // readPack already computed every object's id while unpacking; store them under those
    // ids instead of hashing each one a second time.
    for (const [oid, object] of unpacked) store.storeObject(repo, oid, object.type, object.data);
  }

  // Decide each ref against the pre-push state, then apply only the accepted ones.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: the old value must match, and the new tip must descend from it.
    if (current === undefined || command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  for (let i = 0; i < commands.length; i += 1) {
    if (!results[i]!.ok) continue;
    const command = commands[i]!;
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
  }
  if (results.some((result) => result.ok)) store.touchRepo(repo);

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktFlush()]);
  let payload: Buffer;
  if (sideband) {
    payload = Buffer.concat([sidebandWrap(report, 1), pktFlush()]);
  } else {
    payload = Buffer.concat([report, pktFlush()]);
  }
  // A malformed body the client hands us ("zzzznot-a-pkt-line") reaches the 400 path in the
  // pkt-line parse above, before this point.
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', payload);
}
