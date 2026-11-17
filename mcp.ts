// mcp.ts — Model Context Protocol (POST /mcp) on the same Store the REST routes use.
//
// JSON-RPC 2.0 over streamable HTTP, the modern 2026-07-28 revision: `server/discover`
// answers the server's identity, capabilities and supported versions in one request, so
// there is no handshake and no session. The legacy `initialize` handshake is answered
// too, for clients that predate discover. Every reply is one JSON body (never an SSE
// stream — the client accepts a plain JSON answer), application/json, with an
// X-GitHub-Request-Id header like the REST routes.
//
// Wire rules (the suite's mcp-client.ts):
//   - every request declares its revision in `_meta` and the `MCP-Protocol-Version`
//     header; the server echoes the request's JSON-RPC id verbatim (strings included);
//   - `tools/list` is byte-identical across calls: the tool table is one frozen constant;
//   - unknown tool -> JSON-RPC -32601; missing required argument -> -32602; a body that
//     is not JSON -> HTTP 400 with JSON-RPC -32700; no bearer token -> exactly 401.
// Tools act on the Store, so a repository or issue made over MCP is the same object
// over REST, with the same ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { VIEWER_LOGIN } from './viewer.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** The revision this server speaks, and the older ones it also names. */
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

// ---------------------------------------------------------------------------
// the tool table: one frozen constant, so tools/list serializes identically
// every time (the suite compares two answers byte for byte).
// ---------------------------------------------------------------------------

interface ToolSchemaProperty {
  type: string;
  description: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolSchemaProperty>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, ToolSchemaProperty>,
  required: string[],
): ToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const TOOLS: readonly ToolDefinition[] = Object.freeze([
  tool(
    'create_repo',
    'Create a repository owned by the token owner. Returns the repository object.',
    {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get one repository by owner and name. Returns the repository object.',
    {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository. Returns the issue object.',
    {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository, optionally filtered by state. Returns the issues.',
    {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'get_issue',
    'Get one issue by owner, repository and number. Returns the issue object.',
    {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    ['owner', 'repo', 'issue_number'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch. Returns the pull request object.',
    {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'list_pull_requests',
    'List the pull requests of a repository, optionally filtered by state. Returns the pull requests.',
    {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'merge_pull_request',
    'Merge an open pull request (squash) and close it. Returns the merged pull request object.',
    {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function ownerLogin(repo: RepoRecord): string {
  return repo.owner ?? VIEWER_LOGIN;
}

function repoJson(repo: RepoRecord): Record<string, unknown> {
  const login = ownerLogin(repo);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: repo.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${login}/${repo.name}`,
    url: `/api/v3/repos/${login}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  const login = ownerLogin(repo);
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login, id: repo.id, type: 'User' },
    labels: issue.labels,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://example.invalid/${login}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const login = ownerLogin(repo);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login, id: repo.id, type: 'User' },
    head: { label: `${login}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${login}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    mergeable: store.pullMergeable(repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://example.invalid/${login}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}`,
  };
}

/** A tool result: the JSON both as structured content and as one text block. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** A tool execution failure: isError true with the reason as text. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// tool dispatch
// ---------------------------------------------------------------------------

/** Run one tool. Returns the tool result, or a JSON-RPC error code + message. */
function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  const definition = TOOLS.find((entry) => entry.name === name);
  if (definition === undefined) {
    return { error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Unknown tool: ${name}` } };
  }
  const missing = definition.inputSchema.required.filter((field) => {
    const value = args[field];
    return value === undefined || value === null || (typeof value === 'string' && value === '');
  });
  if (missing.length > 0) {
    return { error: { code: JSON_RPC_INVALID_PARAMS, message: `Missing required argument(s): ${missing.join(', ')}` } };
  }

  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(repoName, { description, private: isPrivate });
      if (repo === null) return { result: toolError(`Repository ${repoName} already exists.`) };
      const owner = stringArg(args, 'owner');
      const view = repoJson(repo);
      if (owner !== '') {
        // The caller named an owner: the REST view binds it on first sight, and the
        // tool result's full_name names it, so a later REST read finds the same repo.
        view.full_name = `${owner}/${repoName}`;
        view.owner = { login: owner, id: repo.id, type: 'User' };
        view.html_url = `https://example.invalid/${owner}/${repoName}`;
        view.url = `/api/v3/repos/${owner}/${repoName}`;
      }
      return { result: toolResult(view) };
    }
    case 'get_repo': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return { result: toolError('Repository not found.') };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return { result: toolError('Repository not found.') };
      const issue = store.createIssue(repo, {
        title: stringArg(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { result: toolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return { result: toolError('Repository not found.') };
      const state = stringArg(args, 'state').toLowerCase();
      let issues = store.listIssues(repo);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const sorted = [...issues].sort((a, b) => b.createdSeq - a.createdSeq);
      return { result: toolResult({ issues: sorted.map((issue) => issueJson(repo, issue)) }) };
    }
    case 'get_issue': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return { result: toolError('Repository not found.') };
      const number = intArg(args, 'issue_number');
      const issue = number === null ? undefined : store.getIssue(repo, number);
      if (issue === undefined) return { result: toolError('Issue not found.') };
      return { result: toolResult(issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return { result: toolError('Repository not found.') };
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (headSha === null || baseSha === null) {
        return { result: toolError('head or base branch does not exist.') };
      }
      const pull = store.createPull(repo, {
        title: stringArg(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return { result: toolResult(pullJson(store, repo, pull)) };
    }
    case 'list_pull_requests': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return { result: toolError('Repository not found.') };
      const state = stringArg(args, 'state').toLowerCase();
      let pulls = store.listPulls(repo);
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      const sorted = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
      return { result: toolResult({ pull_requests: sorted.map((pull) => pullJson(store, repo, pull)) }) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return { result: toolError('Repository not found.') };
      const number = intArg(args, 'pull_number');
      const pull = number === null ? undefined : store.getPull(repo, number);
      if (pull === undefined) return { result: toolError('Pull request not found.') };
      const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
      const result = store.mergePull(repo, pull, message);
      if ('error' in result) {
        return { result: toolError(`Pull request #${pull.number} cannot be merged: ${result.error}.`) };
      }
      return { result: toolResult(pullJson(store, repo, pull)) };
    }
    default:
      return { error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Unknown tool: ${name}` } };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function okResponse(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: unknown, code: number, message: string, data?: unknown): RpcResponse {
  const response: RpcResponse = { jsonrpc: '2.0', id, error: { code, message } };
  if (data !== undefined) response.error!.data = data;
  return response;
}

function discoverResult(): Record<string, unknown> {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

/** One JSON-RPC request (not a notification: it carries an id). */
function handleRpc(store: Store, request: Record<string, unknown>): RpcResponse {
  const id = 'id' in request ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    return okResponse(id, discoverResult());
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : PROTOCOL_VERSION;
    return okResponse(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return okResponse(id, {});
  }
  if (method === 'tools/list') {
    return okResponse(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const outcome = callTool(store, toolName, args);
    if ('error' in outcome) return errorResponse(id, outcome.error.code, outcome.error.message);
    return okResponse(id, outcome.result);
  }
  return errorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function jsonBody(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
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

/** POST /mcp. `requestId` is the reply's X-GitHub-Request-Id value. */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  isAuthorized: boolean,
  requestId: string,
): Promise<void> {
  if (req.method !== 'POST') {
    jsonBody(res, 405, { message: 'Method Not Allowed' }, requestId);
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    jsonBody(res, 400, errorResponse(null, JSON_RPC_PARSE_ERROR, 'Parse error'), requestId);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700, no id to echo.
    jsonBody(res, 400, errorResponse(null, JSON_RPC_PARSE_ERROR, 'Parse error'), requestId);
    return;
  }
  // Authentication is decided before any method exists: a missing or wrong token is
  // 401 even for a method the server would not know.
  if (!isAuthorized) {
    const id = isRecord(parsed) && 'id' in parsed ? parsed.id : null;
    jsonBody(res, 401, errorResponse(id, -32000, 'Unauthorized'), requestId);
    return;
  }
  if (Array.isArray(parsed)) {
    // A JSON-RPC batch: one response per request that carries an id, in order.
    const responses: RpcResponse[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) {
        responses.push(errorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request'));
        continue;
      }
      if (!('id' in entry)) continue; // a notification: no response
      responses.push(handleRpc(store, entry));
    }
    jsonBody(res, 200, responses, requestId);
    return;
  }
  if (!isRecord(parsed)) {
    jsonBody(res, 400, errorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request'), requestId);
    return;
  }
  if (!('id' in parsed)) {
    // A notification (initialize's `notifications/initialized`): nothing to answer.
    res.writeHead(202, { 'x-github-request-id': requestId });
    res.end();
    return;
  }
  jsonBody(res, 200, handleRpc(store, parsed), requestId);
}
