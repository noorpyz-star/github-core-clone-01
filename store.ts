// store.ts — the forge's in-memory store.
//
// Everything the REST, GraphQL, MCP and git surfaces read and write lives here, in memory only
// (the trial mounts /bot read-only and only /tmp is writable, so nothing is persisted to disk).
// A second agent implements issues/pulls labels REST, GraphQL and MCP on top of this store; the
// exported API below is the contract it builds on.
//
// Layout:
//   - git object model: hashObject / parseTree / buildTree / parseCommit / buildCommit / parseTag,
//     exactly as git computes them (SHA-1 over "<type> <len>\0" + payload).
//   - RepoRecord: one repository — metadata, its objects (Map sha -> {type, data}), its refs
//     (Map refname -> sha), and its labels / issues / pulls / comments.
//   - Store: the registry of repositories plus all tree/commit helpers (flattenTree, setPath,
//     diffTrees, mergeTrees, isAncestor, mergeBase) and the issue/pull/label operations.
//
// Owner binding: POST /user/repos carries no owner, and the bearer token's login is opaque to
// this server, so a repository is created with owner=null and binds to the first owner that
// addresses it through an owner-scoped path (GET /repos/{owner}/{name}, a git path, ...). A
// later request under a different owner then answers 404, never 403 — which is the wire rule
// for "the same repository name under another owner".
//
// Determinism: server-created commits use a fixed timestamp and identity, and every created_at
// timestamp derives from a monotonic sequence number, so two runs that see the same requests
// in the same order produce the same bytes.

import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The identity server-created commits carry. */
export const FORGE_IDENTITY = 'forge <forge@localhost>';
/** Fixed Unix timestamp for server-created commits (deterministic across runs). */
export const FIXED_TIMESTAMP = 1700000000;
/** Base epoch (2025-01-01T00:00:00Z) for created_at timestamps; +sequence seconds. */
export const EPOCH_SEC = 1735689600;

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. The message is stored verbatim. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_TIMESTAMP;
  const who = `${fields.author ?? FORGE_IDENTITY} ${timestamp} +0000`;
  const committer = `${fields.committer ?? FORGE_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** "Name <email> 1234567890 +0000" -> { name, email, timestamp }. */
export function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!match) return { name: line.trim(), email: '', timestamp: FIXED_TIMESTAMP };
  return { name: match[1] ?? '', email: match[2] ?? '', timestamp: Number(match[3] ?? FIXED_TIMESTAMP) };
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: CommentRecord[];
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface RepoRecord {
  id: number;
  name: string;
  /** null until the first owner-scoped request binds it (see the header comment). */
  owner: string | null;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: IssueRecord[];
  pulls: PullRecord[];
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export class Store {
  private reposByName = new Map<string, RepoRecord>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private seq = 0;

  /** The next monotonic sequence number (drives created_at ordering). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  isoTime(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString();
  }

  // -- repositories ----------------------------------------------------------

  /** Create a repository; null when a repository of that name already exists. */
  createRepo(name: string, opts: { description?: string; private?: boolean; defaultBranch?: string } = {}): RepoRecord | null {
    if (this.reposByName.has(name)) return null;
    const seq = this.nextSeq();
    const repo: RepoRecord = {
      id: this.nextRepoId++,
      name,
      owner: null,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: this.isoTime(seq),
      updatedAt: this.isoTime(seq),
      createdSeq: seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };
    this.reposByName.set(name, repo);
    return repo;
  }

  /** Find a repository by name alone, without binding an owner. */
  findRepoByName(name: string): RepoRecord | undefined {
    return this.reposByName.get(name);
  }

  /**
   * Resolve owner/name: binds an unbound repository to `owner` on first sight, answers null
   * (404) when the bound owner differs or the repository does not exist.
   */
  getRepo(owner: string, name: string): RepoRecord | null {
    const repo = this.reposByName.get(name);
    if (!repo) return null;
    if (repo.owner === null) repo.owner = owner;
    if (repo.owner !== owner) return null;
    return repo;
  }

  /** Delete a repository; false when it does not exist under that owner. */
  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.reposByName.delete(name);
    return true;
  }

  /** All repositories in creation order (optionally only those bound to `owner`). */
  listRepos(owner?: string): RepoRecord[] {
    const all = [...this.reposByName.values()];
    if (owner === undefined) return all;
    return all.filter((repo) => repo.owner === null || repo.owner === owner);
  }

  touchRepo(repo: RepoRecord): void {
    repo.updatedAt = this.isoTime(this.nextSeq());
  }

  // -- git objects -----------------------------------------------------------

  /** Store an object, returning its SHA-1 id (idempotent). */
  putObject(repo: RepoRecord, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (a pack reader computed it while unpacking):
   * the same insert as putObject, without paying for a second SHA-1. */
  storeObject(repo: RepoRecord, oid: string, type: ObjectType, data: Buffer): void {
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  }

  getObject(repo: RepoRecord, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  hasObject(repo: RepoRecord, oid: string): boolean {
    return repo.objects.has(oid);
  }

  /** Create a commit object in the repo and return its id. */
  createCommit(repo: RepoRecord, fields: { tree: string; parents?: readonly string[]; message: string }): string {
    return this.putObject(repo, 'commit', buildCommit(fields));
  }

  // -- refs ------------------------------------------------------------------

  getRef(repo: RepoRecord, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Set a ref, or delete it when `oid` is null. */
  setRef(repo: RepoRecord, ref: string, oid: string | null): void {
    if (oid === null) repo.refs.delete(ref);
    else repo.refs.set(ref, oid);
  }

  /** All refs, sorted by name. */
  listRefs(repo: RepoRecord): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  defaultRef(repo: RepoRecord): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** The tip commit of the default branch, or null when the repo is unborn. */
  headCommit(repo: RepoRecord): string | null {
    return repo.refs.get(this.defaultRef(repo)) ?? null;
  }

  /**
   * Resolve a ref-ish to a commit id: a full ref, a branch short name, or a raw object id.
   * Tag refs peel to their commit.
   */
  resolveRef(repo: RepoRecord, refish: string): string | null {
    let oid: string | undefined;
    if (refish.startsWith('refs/')) oid = repo.refs.get(refish);
    else if (repo.refs.has(`refs/heads/${refish}`)) oid = repo.refs.get(`refs/heads/${refish}`);
    else if (repo.refs.has(`refs/tags/${refish}`)) oid = repo.refs.get(`refs/tags/${refish}`);
    else if (isObjectId(refish)) oid = refish;
    if (!oid) return null;
    return this.peelToCommit(repo, oid);
  }

  /** Follow a tag object to its commit (or return the id unchanged when it is one). */
  peelToCommit(repo: RepoRecord, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** The object type a ref's target peels to (commit/tree/blob/tag), or null. */
  peelType(repo: RepoRecord, oid: string): ObjectType | null {
    const object = repo.objects.get(oid);
    if (!object) return null;
    if (object.type !== 'tag') return object.type;
    const target = repo.objects.get(parseTag(object.data).object);
    return target?.type ?? null;
  }

  // -- reachability ----------------------------------------------------------

  /**
   * Every object reachable from `roots`: commit -> tree + parents, tree -> entries,
   * tag -> its target. Throws on a missing object unless allowMissing is set.
   */
  collectReachable(repo: RepoRecord, roots: Iterable<string>, opts: { allowMissing?: boolean } = {}): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isObjectId(root)) queue.push(root);
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) {
        if (opts.allowMissing) continue;
        throw new Error(`object ${oid} is missing from the store`);
      }
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** All ancestors of a commit (itself included), following parents. */
  ancestorsOf(repo: RepoRecord, tip: string): Set<string> {
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `descendant` (or they are equal). Walks down from
   * `descendant` and stops the moment `ancestor` is found, so a fast-forward check on a long
   * linear history costs one step (the new tip's parent is the old tip) instead of a
   * full-history walk: the old code collected every ancestor first, ~2.6 us per commit, so a
   * 200-push chain paid ~50 ms a round for this check alone. */
  isAncestor(repo: RepoRecord, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The newest common ancestor of two commits, or null when their histories never meet. */
  mergeBase(repo: RepoRecord, a: string, b: string): string | null {
    const aAncestors = this.ancestorsOf(repo, a);
    const queue: string[] = [b];
    const seen = new Set<string>();
    // An index pointer, not shift(): shift() re-indexes the whole queue on every pop, which
    // turns a 200-commit walk quadratic.
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head]!;
      head += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /**
   * Objects reachable from `included` commits without following any parent outside the set
   * (the shallow-clone walk: commits + their full trees, history cut at the boundary).
   */
  collectShallow(repo: RepoRecord, included: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [];
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') queue.push(oid);
      else if (object) out.add(oid);
    }
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (out.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      out.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        const treeQueue = [commit.tree];
        while (treeQueue.length > 0) {
          const treeOid = treeQueue.pop()!;
          if (out.has(treeOid)) continue;
          const treeObject = repo.objects.get(treeOid);
          if (!treeObject) continue;
          out.add(treeOid);
          if (treeObject.type === 'tree') {
            for (const entry of parseTree(treeObject.data)) {
              if (entry.mode === '40000') treeQueue.push(entry.oid);
              else out.add(entry.oid);
            }
          }
        }
      }
    }
    return out;
  }

  // -- trees -----------------------------------------------------------------

  /** Flatten a tree into path -> { oid, mode }, recursing into directories. */
  flattenTree(repo: RepoRecord, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The blob id at `path` in the tree at `commitOid`, or null. */
  getPathBlob(repo: RepoRecord, commitOid: string, path: string): string | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const flat = this.flattenTree(repo, parseCommit(commit.data).tree);
    return flat.get(path)?.oid ?? null;
  }

  /** The tree id at `commitOid`, or the empty tree when the commit is null. */
  treeOf(repo: RepoRecord, commitOid: string | null): string {
    if (commitOid === null) return EMPTY_TREE_OID;
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return EMPTY_TREE_OID;
    return parseCommit(commit.data).tree;
  }

  /**
   * A new tree with `path` set to `blobOid` (or removed when null), derived from `baseTreeOid`.
   * Intermediate directories are created or pruned as needed; the empty tree is returned when
   * nothing is left. Every new tree object is stored.
   */
  setPath(repo: RepoRecord, baseTreeOid: string, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((part) => part !== '');
    if (segments.length === 0) return baseTreeOid;
    const build = (treeOid: string, depth: number): string | null => {
      const object = repo.objects.get(treeOid);
      const entries: TreeEntry[] = object?.type === 'tree' ? parseTree(object.data) : [];
      const name = segments[depth]!;
      const last = depth === segments.length - 1;
      const next: TreeEntry[] = [];
      let replaced = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          next.push(entry);
          continue;
        }
        replaced = true;
        if (last) {
          if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = build(entry.oid, depth + 1);
          if (child !== null) next.push({ mode: '40000', name, oid: child });
        }
      }
      if (!replaced) {
        if (last) {
          if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = build(EMPTY_TREE_OID, depth + 1);
          if (child !== null) next.push({ mode: '40000', name, oid: child });
        }
      }
      if (next.length === 0) return null;
      return this.putObject(repo, 'tree', buildTree(next));
    };
    if (baseTreeOid === EMPTY_TREE_OID && blobOid === null) return EMPTY_TREE_OID;
    return build(baseTreeOid, 0) ?? EMPTY_TREE_OID;
  }

  /** Immediate children of a directory `dirPath` ('' = root) in the tree at `commitOid`. */
  listDir(repo: RepoRecord, commitOid: string, dirPath: string): Array<{ name: string; path: string; oid: string; mode: string }> | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    if (dirPath !== '') {
      const segments = dirPath.split('/').filter((part) => part !== '');
      for (const segment of segments) {
        const object = repo.objects.get(treeOid);
        if (!object || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (!entry || entry.mode !== '40000') return null;
        treeOid = entry.oid;
      }
    }
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      oid: entry.oid,
      mode: entry.mode,
    }));
  }

  /** Line-diff counts between two blobs (LCS over lines); identical blobs give 0/0. */
  diffBlobCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    if (oldData !== null && newData !== null && oldData.equals(newData)) return { additions: 0, deletions: 0 };
    const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
    const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
    if (oldData !== null && oldData.length === 0) oldLines.length = 0;
    if (newData !== null && newData.length === 0) newLines.length = 0;
    // LCS length via a compact DP over the shorter side.
    const a = oldLines.length <= newLines.length ? oldLines : newLines;
    const b = oldLines.length <= newLines.length ? newLines : oldLines;
    let prev = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
      const cur = new Array<number>(b.length + 1).fill(0);
      for (let j = 1; j <= b.length; j += 1) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    const common = prev[b.length];
    return { additions: newLines.length - common, deletions: oldLines.length - common };
  }

  /** The file changes between two trees (merge-base -> head for a pull request). */
  diffTrees(repo: RepoRecord, baseTreeOid: string, headTreeOid: string): FileChange[] {
    const base = baseTreeOid === EMPTY_TREE_OID ? new Map() : this.flattenTree(repo, baseTreeOid);
    const head = headTreeOid === EMPTY_TREE_OID ? new Map() : this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
      const oldData = oldEntry ? repo.objects.get(oldEntry.oid)?.data ?? null : null;
      const newData = newEntry ? repo.objects.get(newEntry.oid)?.data ?? null : null;
      const counts = this.diffBlobCounts(oldData, newData);
      out.push({
        path,
        status: !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified',
        oldOid: oldEntry?.oid ?? null,
        newOid: newEntry?.oid ?? null,
        additions: counts.additions,
        deletions: counts.deletions,
      });
    }
    return out;
  }

  /**
   * Three-way merge of trees: base (merge-base), ours (base branch tip), theirs (head tip).
   * Returns the merged tree id and the conflicting paths (same path changed differently on
   * both sides). Merged trees are stored.
   */
  mergeTrees(
    repo: RepoRecord,
    baseTreeOid: string,
    oursTreeOid: string,
    theirsTreeOid: string,
  ): { tree: string; conflicts: string[] } {
    const base = baseTreeOid === EMPTY_TREE_OID ? new Map() : this.flattenTree(repo, baseTreeOid);
    const ours = oursTreeOid === EMPTY_TREE_OID ? new Map() : this.flattenTree(repo, oursTreeOid);
    const theirs = theirsTreeOid === EMPTY_TREE_OID ? new Map() : this.flattenTree(repo, theirsTreeOid);
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const conflicts: string[] = [];
    let tree = EMPTY_TREE_OID;
    for (const path of [...paths].sort()) {
      const b = base.get(path)?.oid ?? null;
      const o = ours.get(path)?.oid ?? null;
      const t = theirs.get(path)?.oid ?? null;
      if (o === t) {
        tree = this.setPath(repo, tree, path, o);
      } else if (b === o) {
        tree = this.setPath(repo, tree, path, t);
      } else if (b === t) {
        tree = this.setPath(repo, tree, path, o);
      } else {
        conflicts.push(path);
        tree = this.setPath(repo, tree, path, o);
      }
    }
    return { tree, conflicts };
  }

  // -- labels ---------------------------------------------------------------

  /** Create a label; null when a label of that name already exists. */
  addLabel(repo: RepoRecord, name: string, color = 'ededed', description = ''): LabelRecord | null {
    if (repo.labels.has(name)) return null;
    const label: LabelRecord = { id: repo.nextLabelId++, name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  getLabel(repo: RepoRecord, name: string): LabelRecord | undefined {
    return repo.labels.get(name);
  }

  listLabels(repo: RepoRecord): LabelRecord[] {
    return [...repo.labels.values()];
  }

  // -- issues ---------------------------------------------------------------

  createIssue(repo: RepoRecord, input: { title: string; body?: string; labels?: string[] }): IssueRecord {
    const seq = this.nextSeq();
    const issue: IssueRecord = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      createdSeq: seq,
      createdAt: this.isoTime(seq),
      updatedAt: this.isoTime(seq),
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: RepoRecord, number: number): IssueRecord | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: RepoRecord): IssueRecord[] {
    return [...repo.issues];
  }

  updateIssue(repo: RepoRecord, number: number, patch: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[] }): IssueRecord | null {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.labels !== undefined) issue.labels = [...patch.labels];
    if (patch.state !== undefined && patch.state !== issue.state) {
      issue.state = patch.state;
      issue.closedAt = patch.state === 'closed' ? this.isoTime(this.nextSeq()) : null;
    }
    issue.updatedAt = this.isoTime(this.nextSeq());
    return issue;
  }

  addComment(repo: RepoRecord, number: number, body: string): CommentRecord | null {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    const seq = this.nextSeq();
    const comment: CommentRecord = { id: repo.nextCommentId++, body, createdAt: this.isoTime(seq), updatedAt: this.isoTime(seq) };
    issue.comments.push(comment);
    return comment;
  }

  listComments(repo: RepoRecord, number: number): CommentRecord[] | null {
    const issue = this.getIssue(repo, number);
    return issue ? [...issue.comments] : null;
  }

  // -- pull requests --------------------------------------------------------

  createPull(
    repo: RepoRecord,
    input: { title: string; body?: string; headRef: string; baseRef: string; headSha: string; baseSha: string },
  ): PullRecord {
    const seq = this.nextSeq();
    const pull: PullRecord = {
      id: this.nextPullId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.headRef,
      baseRef: input.baseRef,
      headSha: input.headSha,
      baseSha: input.baseSha,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      createdSeq: seq,
      createdAt: this.isoTime(seq),
      updatedAt: this.isoTime(seq),
      closedAt: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: RepoRecord, number: number): PullRecord | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: RepoRecord): PullRecord[] {
    return [...repo.pulls];
  }

  /**
   * Try to merge a pull request (squash): returns the merge commit id, or null + a reason
   * ('conflict' | 'already-merged' | 'unknown-head'). On success the base branch advances
   * and the pull is closed and marked merged. The caller supplies the merge commit message.
   */
  mergePull(repo: RepoRecord, pull: PullRecord, message: string): { sha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'already-merged' };
    const baseTip = this.resolveRef(repo, pull.baseRef);
    const headTip = this.resolveRef(repo, pull.headRef);
    if (baseTip === null || headTip === null) return { error: 'unknown-head' };
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseTree = this.treeOf(repo, base);
    const oursTree = this.treeOf(repo, baseTip);
    const theirsTree = this.treeOf(repo, headTip);
    const merged = this.mergeTrees(repo, baseTree, oursTree, theirsTree);
    if (merged.conflicts.length > 0) return { error: 'conflict' };
    const sha = this.createCommit(repo, { tree: merged.tree, parents: [baseTip], message });
    this.setRef(repo, `refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    const seq = this.nextSeq();
    pull.mergedAt = this.isoTime(seq);
    pull.closedAt = pull.mergedAt;
    pull.updatedAt = pull.mergedAt;
    this.touchRepo(repo);
    return { sha };
  }

  /** Whether a pull request would merge cleanly right now (no side effects). */
  pullMergeable(repo: RepoRecord, pull: PullRecord): boolean {
    if (pull.state !== 'open') return false;
    const baseTip = this.resolveRef(repo, pull.baseRef);
    const headTip = this.resolveRef(repo, pull.headRef);
    if (baseTip === null || headTip === null) return false;
    const base = this.mergeBase(repo, baseTip, headTip);
    const merged = this.mergeTrees(repo, this.treeOf(repo, base), this.treeOf(repo, baseTip), this.treeOf(repo, headTip));
    return merged.conflicts.length === 0;
  }

  /** The file changes of a pull request (merge-base tree -> head tree). */
  pullFiles(repo: RepoRecord, pull: PullRecord): FileChange[] {
    const baseTip = this.resolveRef(repo, pull.baseRef);
    const headTip = this.resolveRef(repo, pull.headRef);
    if (baseTip === null || headTip === null) return [];
    const base = this.mergeBase(repo, baseTip, headTip);
    return this.diffTrees(repo, this.treeOf(repo, base), this.treeOf(repo, headTip));
  }
}
