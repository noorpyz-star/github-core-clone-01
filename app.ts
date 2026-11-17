// app.ts — the forge's HTTP server: REST v3, git smart HTTP, GraphQL v4 and MCP.
//
// Every REST reply is application/json, never HTML, and carries a non-empty
// X-GitHub-Request-Id header. Errors carry a JSON body with a string message. A request
// without the bearer token (MAKEFUN_SHOP_TOKEN) is 401; a repository belongs to the login
// the token names, so the same name under another owner is 404, never 403. A malformed
// JSON body is 400; an unknown route is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Store,
  parseCommit,
  parseIdentity,
  type CommentRecord,
  type IssueRecord,
  type LabelRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './viewer.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function tokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}

/** The bearer token this server accepts; empty when the env did not set one (dev only). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(req: IncomingMessage): boolean {
  const presented = tokenOf(req);
  if (presented === null || presented === '') return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return presented === expected;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringField(body: JsonObject, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function boolField(body: JsonObject, field: string, fallback: boolean): boolean {
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------

function ownerLogin(repo: RepoRecord): string {
  return repo.owner ?? 'owner';
}

function repoJson(repo: RepoRecord): JsonObject {
  const login = ownerLogin(repo);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: repo.id, type: 'User', html_url: `https://example.invalid/${login}` },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${login}/${repo.name}`,
    url: `/api/v3/repos/${login}/${repo.name}`,
    clone_url: `https://example.invalid/${login}/${repo.name}.git`,
    git_url: `git://example.invalid/${login}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${login}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, push: true, pull: true },
  };
}

function labelJson(repo: RepoRecord, label: LabelRecord): JsonObject {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    url: `/api/v3/repos/${ownerLogin(repo)}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}

function issueJson(repo: RepoRecord, issue: IssueRecord): JsonObject {
  const login = ownerLogin(repo);
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login, id: repo.id, type: 'User' },
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is LabelRecord => label !== undefined)
      .map((label) => labelJson(repo, label)),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://example.invalid/${login}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${login}/${repo.name}`,
    locked: false,
    author_association: 'OWNER',
  };
}

function commentJson(repo: RepoRecord, issue: IssueRecord, comment: CommentRecord): JsonObject {
  const login = ownerLogin(repo);
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login, id: repo.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function pullJson(store: Store, repo: RepoRecord, pull: PullRecord): JsonObject {
  const login = ownerLogin(repo);
  const mergeable = store.pullMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login, id: repo.id, type: 'User' },
    head: {
      label: `${login}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login, id: repo.id, type: 'User' },
      repo: { id: repo.id, name: repo.name, full_name: `${login}/${repo.name}` },
    },
    base: {
      label: `${login}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login, id: repo.id, type: 'User' },
      repo: { id: repo.id, name: repo.name, full_name: `${login}/${repo.name}` },
    },
    merged: pull.merged,
    mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://example.invalid/${login}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    locked: false,
    author_association: 'OWNER',
  };
}

function commitJson(store: Store, repo: RepoRecord, sha: string): JsonObject | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  const login = ownerLogin(repo);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: commit.message,
      tree: { sha: commit.tree },
      author: { name: author.name, email: author.email, date: new Date(author.timestamp * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date(committer.timestamp * 1000).toISOString() },
    },
    author: { login, id: repo.id, type: 'User' },
    committer: { login, id: repo.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${login}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${login}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string, host: string): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const nextQuery = new URLSearchParams(query);
    nextQuery.set('page', String(page + 1));
    nextQuery.set('per_page', String(perPage));
    link = `<http://${host}${basePath}?${nextQuery.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

// ---------------------------------------------------------------------------
// the app
// ---------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, store).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        // The response is already gone; nothing left to do.
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const rawPath = url.pathname.replace(/\/+$/, '') || '/';
  const segments = rawPath.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const host = req.headers.host ?? 'localhost';

  // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
  if (method === 'GET' && rawPath === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // -- git smart HTTP --------------------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (gitMatch !== null) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const repo = store.getRepo(owner, repoName);
    const service = gitMatch[3]!;
    const body = await readBody(req);
    if (service === 'info/refs') {
      const serviceParam = url.searchParams.get('service') ?? '';
      handleInfoRefs(req, res, repo, store, serviceParam);
      return;
    }
    if (service === 'git-upload-pack') {
      handleUploadPack(req, res, repo, store, body);
      return;
    }
    handleReceivePack(req, res, repo, store, body);
    return;
  }

  // -- REST v3 ---------------------------------------------------------------
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    await handleRest(req, res, store, method, segments, url, host);
    return;
  }

  // -- GraphQL v4 ------------------------------------------------------------
  if (rawPath === '/api/graphql') {
    await handleGraphQL(req, res, store, isAuthorized(req), nextRequestId());
    return;
  }

  // -- MCP -------------------------------------------------------------------
  if (rawPath === '/mcp') {
    await handleMcp(req, res, store, isAuthorized(req), nextRequestId());
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  method: string,
  segments: string[],
  url: URL,
  host: string,
): Promise<void> {
  const rest = segments.slice(2); // after api/v3
  const query = url.searchParams;

  // Parse a JSON body when one is present; a malformed body is 400.
  let bodyObj: JsonObject = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const object = asObject(parsed);
      if (object === null) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      bodyObj = object;
    }
  }

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/user — the token owner.
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: `U_${VIEWER_ID}`,
      type: 'User',
      html_url: `https://example.invalid/${VIEWER_LOGIN}`,
      url: '/api/v3/user',
    });
    return;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }

  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = stringField(bodyObj, 'name');
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const repo = store.createRepo(name, {
        description: stringField(bodyObj, 'description'),
        private: boolField(bodyObj, 'private', false),
      });
      if (repo === null) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return;
      }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const repos = store.listRepos();
      const { page, link } = paginate(repos, query, '/api/v3/user/repos', host);
      sendJson(res, 200, page.map((repo) => repoJson(repo)), link === null ? {} : { link });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const repoName = rest[2]!;
    const repo = store.getRepo(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    await handleRepoRoutes(req, res, store, method, repo, rest.slice(3), bodyObj, query, host);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRepoRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  method: string,
  repo: RepoRecord,
  tail: string[],
  bodyObj: JsonObject,
  query: URLSearchParams,
  host: string,
): Promise<void> {
  const basePath = `/api/v3/repos/${ownerLogin(repo)}/${repo.name}`;

  // /repos/{o}/{r} itself
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof bodyObj.description === 'string') repo.description = bodyObj.description;
      if (typeof bodyObj.private === 'boolean') repo.private = bodyObj.private;
      store.touchRepo(repo);
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(ownerLogin(repo), repo.name);
      sendNoContent(res, 204);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GET /repos/{o}/{r}/branches
  if (tail.length === 1 && tail[0] === 'branches') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const branches = store
      .listRefs(repo)
      .filter((ref) => ref.name.startsWith('refs/heads/'))
      .map((ref) => ({
        name: ref.name.slice('refs/heads/'.length),
        commit: { sha: ref.oid, url: `${basePath}/commits/${ref.oid}` },
        protected: false,
      }));
    sendJson(res, 200, branches);
    return;
  }

  // GET /repos/{o}/{r}/commits
  if (tail.length === 1 && tail[0] === 'commits') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const refish = query.get('sha') ?? query.get('ref') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, refish);
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const seen = new Set<string>();
    const order: string[] = [];
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      order.push(oid);
      const commit = parseCommit(object.data);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    const { page, link } = paginate(order, query, `${basePath}/commits`, host);
    const items = page.map((sha) => commitJson(store, repo, sha)).filter((item): item is JsonObject => item !== null);
    sendJson(res, 200, items, link === null ? {} : { link });
    return;
  }

  // POST /repos/{o}/{r}/git/refs
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const ref = stringField(bodyObj, 'ref');
    const sha = stringField(bodyObj, 'sha');
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
      sendJson(res, 422, { message: 'Invalid ref or sha' });
      return;
    }
    if (store.getRef(repo, ref) !== undefined) {
      sendJson(res, 422, { message: 'Reference already exists' });
      return;
    }
    store.setRef(repo, ref, sha);
    const type = repo.objects.get(sha)?.type ?? 'commit';
    sendJson(res, 201, {
      ref,
      node_id: `RF_${ref}`,
      url: `${basePath}/git/refs/${encodeURIComponent(ref)}`,
      object: { sha, type, url: `${basePath}/git/${type}s/${sha}` },
    });
    return;
  }

  // /repos/{o}/{r}/contents/{path...}
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    await handleContents(res, store, repo, method, path, bodyObj, query);
    return;
  }

  // /repos/{o}/{r}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'GET') {
      sendJson(res, 200, store.listLabels(repo).map((label) => labelJson(repo, label)));
      return;
    }
    if (method === 'POST') {
      const name = stringField(bodyObj, 'name');
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      const label = store.addLabel(repo, name, stringField(bodyObj, 'color') || 'ededed', stringField(bodyObj, 'description'));
      if (label === null) {
        sendJson(res, 422, { message: 'Label already exists' });
        return;
      }
      sendJson(res, 201, labelJson(repo, label));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /repos/{o}/{r}/issues[/{n}[/comments]]
  if (tail[0] === 'issues') {
    await handleIssues(res, store, repo, method, tail.slice(1), bodyObj, query, host, basePath);
    return;
  }

  // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (tail[0] === 'pulls') {
    await handlePulls(res, store, repo, method, tail.slice(1), bodyObj, query, host, basePath);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function contentsFileJson(repo: RepoRecord, path: string, blobOid: string, contentBase64: string): JsonObject {
  const name = path.split('/').pop() ?? path;
  const login = ownerLogin(repo);
  const size = Buffer.from(contentBase64, 'base64').length;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    sha: blobOid,
    content: contentBase64,
    url: `/api/v3/repos/${login}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${login}/${repo.name}/blob/HEAD/${path}`,
    git_url: `/api/v3/repos/${login}/${repo.name}/git/blobs/${blobOid}`,
    download_url: `https://example.invalid/${login}/${repo.name}/raw/HEAD/${path}`,
    _links: { self: `/api/v3/repos/${login}/${repo.name}/contents/${path}` },
  };
}

async function handleContents(
  res: ServerResponse,
  store: Store,
  repo: RepoRecord,
  method: string,
  path: string,
  bodyObj: JsonObject,
  query: URLSearchParams,
): Promise<void> {
  const login = ownerLogin(repo);
  const refish = query.get('ref') ?? (typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defaultBranch);
  const branchName = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defaultBranch;

  if (method === 'GET') {
    const tip = store.resolveRef(repo, query.get('ref') ?? repo.defaultBranch);
    if (tip === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (path === '') {
      const entries = store.listDir(repo, tip, '') ?? [];
      sendJson(res, 200, entries.map((entry) => dirEntryJson(repo, entry)));
      return;
    }
    const blobOid = store.getPathBlob(repo, tip, path);
    if (blobOid !== null) {
      const blob = repo.objects.get(blobOid);
      const contentBase64 = blob ? blob.data.toString('base64') : '';
      sendJson(res, 200, contentsFileJson(repo, path, blobOid, contentBase64));
      return;
    }
    const entries = store.listDir(repo, tip, path);
    if (entries !== null) {
      sendJson(res, 200, entries.map((entry) => dirEntryJson(repo, entry)));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (method === 'PUT') {
    const message = stringField(bodyObj, 'message');
    const contentBase64 = stringField(bodyObj, 'content');
    if (contentBase64 === '') {
      sendJson(res, 422, { message: 'content is required' });
      return;
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    } catch {
      sendJson(res, 422, { message: 'content is not valid base64' });
      return;
    }
    const tip = store.resolveRef(repo, branchName);
    if (branchName !== repo.defaultBranch && tip === null && store.getRef(repo, `refs/heads/${branchName}`) === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const current = tip === null ? null : store.getPathBlob(repo, tip, path);
    const givenSha = typeof bodyObj.sha === 'string' ? bodyObj.sha : null;
    if (givenSha !== null) {
      if (current === null || givenSha.toLowerCase() !== current.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return;
      }
    } else if (current !== null) {
      sendJson(res, 422, { message: 'file already exists' });
      return;
    }
    const blobOid = store.putObject(repo, 'blob', content);
    const baseTree = store.treeOf(repo, tip);
    const tree = store.setPath(repo, baseTree, path, blobOid);
    const commitSha = store.createCommit(repo, { tree, parents: tip === null ? [] : [tip], message });
    store.setRef(repo, `refs/heads/${branchName}`, commitSha);
    store.touchRepo(repo);
    sendJson(res, current === null ? 201 : 200, {
      content: contentsFileJson(repo, path, blobOid, content.toString('base64')),
      commit: { sha: commitSha, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const tip = store.resolveRef(repo, refish);
    if (tip === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const current = store.getPathBlob(repo, tip, path);
    if (current === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const givenSha = typeof bodyObj.sha === 'string' ? bodyObj.sha : null;
    if (givenSha !== null && givenSha.toLowerCase() !== current.toLowerCase()) {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return;
    }
    const message = stringField(bodyObj, 'message');
    const baseTree = store.treeOf(repo, tip);
    const tree = store.setPath(repo, baseTree, path, null);
    const commitSha = store.createCommit(repo, { tree, parents: [tip], message });
    store.setRef(repo, `refs/heads/${branchName}`, commitSha);
    store.touchRepo(repo);
    sendJson(res, 200, { commit: { sha: commitSha, message } });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function dirEntryJson(repo: RepoRecord, entry: { name: string; path: string; oid: string; mode: string }): JsonObject {
  const login = ownerLogin(repo);
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: entry.path,
    sha: entry.oid,
    size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    url: `/api/v3/repos/${login}/${repo.name}/contents/${entry.path}`,
    html_url: `https://example.invalid/${login}/${repo.name}/tree/HEAD/${entry.path}`,
    git_url: `/api/v3/repos/${login}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    download_url: isDir ? null : `https://example.invalid/${login}/${repo.name}/raw/HEAD/${entry.path}`,
    _links: { self: `/api/v3/repos/${login}/${repo.name}/contents/${entry.path}` },
  };
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

async function handleIssues(
  res: ServerResponse,
  store: Store,
  repo: RepoRecord,
  method: string,
  tail: string[],
  bodyObj: JsonObject,
  query: URLSearchParams,
  host: string,
  basePath: string,
): Promise<void> {
  // /issues
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = stringField(bodyObj, 'title');
      if (title === '') {
        sendJson(res, 422, { message: 'title is required' });
        return;
      }
      const labels = Array.isArray(bodyObj.labels) ? bodyObj.labels.filter((item): item is string => typeof item === 'string') : [];
      for (const name of labels) {
        if (!store.getLabel(repo, name)) {
          sendJson(res, 422, { message: `Label '${name}' does not exist` });
          return;
        }
      }
      const issue = store.createIssue(repo, { title, body: stringField(bodyObj, 'body'), labels });
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = store.listIssues(repo);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues = [...issues].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page, link } = paginate(issues, query, `${basePath}/issues`, host);
      sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), link === null ? {} : { link });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  if (!Number.isInteger(number) || number < 1) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const issue = store.getIssue(repo, number);
  if (!issue) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const body = stringField(bodyObj, 'body');
      if (body === '') {
        sendJson(res, 422, { message: 'body is required' });
        return;
      }
      const comment = store.addComment(repo, number, body);
      if (comment === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 201, commentJson(repo, issue, comment));
      return;
    }
    if (method === 'GET') {
      const comments = store.listComments(repo, number) ?? [];
      sendJson(res, 200, comments.map((comment) => commentJson(repo, issue, comment)));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /issues/{n}
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const patch: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[] } = {};
      if (typeof bodyObj.title === 'string') patch.title = bodyObj.title;
      if (typeof bodyObj.body === 'string') patch.body = bodyObj.body;
      if (bodyObj.state === 'open' || bodyObj.state === 'closed') patch.state = bodyObj.state;
      if (Array.isArray(bodyObj.labels)) {
        const labels = bodyObj.labels.filter((item): item is string => typeof item === 'string');
        for (const name of labels) {
          if (!store.getLabel(repo, name)) {
            sendJson(res, 422, { message: `Label '${name}' does not exist` });
            return;
          }
        }
        patch.labels = labels;
      }
      const updated = store.updateIssue(repo, number, patch);
      if (updated === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, issueJson(repo, updated));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

async function handlePulls(
  res: ServerResponse,
  store: Store,
  repo: RepoRecord,
  method: string,
  tail: string[],
  bodyObj: JsonObject,
  query: URLSearchParams,
  host: string,
  basePath: string,
): Promise<void> {
  // /pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      const head = stringField(bodyObj, 'head');
      const base = stringField(bodyObj, 'base');
      const title = stringField(bodyObj, 'title');
      if (head === '' || base === '' || title === '') {
        sendJson(res, 422, { message: 'head, base and title are required' });
        return;
      }
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (headSha === null || baseSha === null) {
        sendJson(res, 422, { message: 'head or base branch does not exist' });
        return;
      }
      const pull = store.createPull(repo, {
        title,
        body: stringField(bodyObj, 'body'),
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      sendJson(res, 201, pullJson(store, repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = store.listPulls(repo);
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(pulls, query, `${basePath}/pulls`, host);
      sendJson(res, 200, page.map((pull) => pullJson(store, repo, pull)), link === null ? {} : { link });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  if (!Number.isInteger(number) || number < 1) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pull = store.getPull(repo, number);
  if (!pull) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const login = ownerLogin(repo);
    const files = store.pullFiles(repo, pull).map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      sha: change.newOid ?? change.oldOid ?? '',
      blob_url: `https://example.invalid/${login}/${repo.name}/blob/${pull.headSha}/${change.path}`,
      raw_url: `https://example.invalid/${login}/${repo.name}/raw/${pull.headSha}/${change.path}`,
      contents_url: `${basePath}/contents/${change.path}?ref=${pull.headSha}`,
    }));
    sendJson(res, 200, files);
    return;
  }

  // /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const result = store.mergePull(repo, pull, message);
    if ('error' in result) {
      if (result.error === 'conflict') {
        sendJson(res, 405, { message: 'Merge conflict' });
        return;
      }
      sendJson(res, 405, { message: 'Pull request cannot be merged' });
      return;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    return;
  }

  // /pulls/{n}
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(store, repo, pull));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
