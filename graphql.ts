// graphql.ts — GraphQL v4 (POST /api/graphql) on the same Store the REST routes use.
//
// A small hand-written GraphQL executor, stdlib only: a tokenizer and recursive-descent
// parser for the documents gh and github-mcp-server actually send, a resolver table per
// type, and the `__type` introspection those clients feature-detect with. No GraphQL
// library, no schema language file — the schema lives in the FIELD tables below, which
// double as the introspection answers and the unknown-field validation.
//
// Wire rules (the suite's graphql-client.ts):
//   - one operation per body, or a JSON array of operations (GitHub batching), answered
//     in the same order;
//   - a GraphQL-level failure (unknown field, bad argument) is HTTP 200 with an `errors`
//     array, never a 4xx; an unauthenticated request is exactly 401;
//   - every reply is application/json and carries X-GitHub-Request-Id like the REST routes.
// Global ids reuse the REST node_id scheme (R_<id>, I_<id>, PR_<id>, IC_<id>): opaque,
// stable across reads, never the plain database id or number.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { VIEWER_ID, VIEWER_LOGIN } from './viewer.ts';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: Record<string, ValueNode>; selections: SelectionNode[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; type: string }>;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Record<string, SelectionNode[]>;
}

class GraphQLSyntaxError extends Error {}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        const c = source[i]!;
        if (c === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc;
          i += 2;
          continue;
        }
        value += c;
        i += 1;
      }
      if (i >= source.length) throw new GraphQLSyntaxError('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isDigit(ch) || (ch === '-' && isDigit(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && isDigit(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`expected "${value}" but got ${token.kind === 'eof' ? 'end of document' : JSON.stringify((token as { value?: string }).value)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`expected ${what}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments: Record<string, SelectionNode[]> = {};
    for (;;) {
      const token = this.peek();
      if (token.kind === 'eof') break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push(this.parseOperation(null));
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        this.expectName('the "on" keyword');
        this.expectName('a type condition');
        fragments[name] = this.parseSelectionSet();
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation(token.value as 'query' | 'mutation'));
        continue;
      }
      throw new GraphQLSyntaxError(`unexpected ${token.kind === 'name' ? JSON.stringify(token.value) : token.kind} at the top level`);
    }
    if (operations.length === 0) throw new GraphQLSyntaxError('the document holds no operation');
    return { operations, fragments };
  }

  private parseOperation(kindHint: 'query' | 'mutation' | null): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    if (kindHint !== null) {
      kind = kindHint;
      this.next();
    }
    let name: string | null = null;
    const next = this.peek();
    if (next.kind === 'name') name = this.next().value as string;
    const variableDefinitions: Array<{ name: string; type: string }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName('a variable name');
        this.expectPunct(':');
        const type = this.parseType();
        if (this.acceptPunct('=')) this.parseValue();
        variableDefinitions.push({ name: varName, type });
      }
    }
    // Directives on the operation (@...) are not used by the suite's documents; skip them.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.acceptPunct('(')) this.parseArgumentsRaw();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variableDefinitions, selections };
  }

  private parseType(): string {
    let type: string;
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = `[${inner}]`;
    } else {
      type = this.expectName('a type name');
    }
    if (this.acceptPunct('!')) type += '!';
    return type;
  }

  private parseArgumentsRaw(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    while (!this.acceptPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.acceptPunct('...')) {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value as string };
      }
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName('a field name');
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName('a field name after the alias');
    }
    let args: Record<string, ValueNode> = {};
    if (this.acceptPunct('(')) args = this.parseArgumentsRaw();
    // Directives on a field (@...) are not used by the suite's documents; skip them.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.acceptPunct('(')) this.parseArgumentsRaw();
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLSyntaxError('expected a value');
  }
}

// ---------------------------------------------------------------------------
// schema: the field table per type (introspection source and validation source)
// ---------------------------------------------------------------------------

/** The fields a type answers, in a stable order. */
const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt',
  ],
  User: ['id', 'login'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt',
  ],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

/** The enum values a type answers (only enum types are listed). */
const TYPE_ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------
// global ids (the REST node_id scheme, reused so ids agree across surfaces)
// ---------------------------------------------------------------------------

function repoGlobalId(repo: RepoRecord): string {
  return `R_${repo.id}`;
}

function issueGlobalId(issue: IssueRecord): string {
  return `I_${issue.id}`;
}

function pullGlobalId(pull: PullRecord): string {
  return `PR_${pull.id}`;
}

function commentGlobalId(commentId: number): string {
  return `IC_${commentId}`;
}

interface DecodedId {
  kind: 'repo' | 'issue' | 'pull' | 'comment';
  id: number;
}

function decodeGlobalId(value: string): DecodedId | null {
  const match = /^(R|I|PR|IC)_(\d+)$/.exec(value);
  if (match === null) return null;
  const prefix = match[1]!;
  const id = Number.parseInt(match[2]!, 10);
  if (prefix === 'R') return { kind: 'repo', id };
  if (prefix === 'I') return { kind: 'issue', id };
  if (prefix === 'PR') return { kind: 'pull', id };
  return { kind: 'comment', id };
}

// ---------------------------------------------------------------------------
// execution context and helpers
// ---------------------------------------------------------------------------

interface ExecEnv {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type GqlObject = Record<string, unknown> & { __typename: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(args)) out[name] = resolveValue(node, variables);
  return out;
}

/** The cursor a connection page ends on: base64 of the next offset, opaque to the client. */
function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return 0;
    return Number.parseInt(match[1]!, 10);
  } catch {
    return 0;
  }
}

/** A connection page over already-ordered items. */
function paginateItems<T>(items: readonly T[], first: number, after: unknown): { nodes: T[]; pageInfo: GqlObject } {
  const offset = decodeCursor(after);
  const start = Math.max(0, offset);
  const count = Number.isFinite(first) && first >= 0 ? first : items.length;
  const nodes = items.slice(start, start + count);
  const end = start + nodes.length;
  return {
    nodes,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < items.length,
      endCursor: nodes.length === 0 ? null : encodeCursor(end),
    },
  };
}

// ---------------------------------------------------------------------------
// record lookups across repositories (global ids are store-wide for issues/pulls)
// ---------------------------------------------------------------------------

function findRepoByDatabaseId(store: Store, databaseId: number): RepoRecord | null {
  for (const repo of store.listRepos()) if (repo.id === databaseId) return repo;
  return null;
}

function findIssueById(store: Store, id: number): { repo: RepoRecord; issue: IssueRecord } | null {
  for (const repo of store.listRepos()) {
    const issue = repo.issues.find((entry) => entry.id === id);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPullById(store: Store, id: number): { repo: RepoRecord; pull: PullRecord } | null {
  for (const repo of store.listRepos()) {
    const pull = repo.pulls.find((entry) => entry.id === id);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------------------
// typed views: store records as GraphQL objects
// ---------------------------------------------------------------------------

function viewerObject(): GqlObject {
  return { __typename: 'User', id: `U_${VIEWER_ID}`, login: VIEWER_LOGIN };
}

function repoObject(repo: RepoRecord): GqlObject {
  return { __typename: 'Repository', __repo: repo, id: repoGlobalId(repo), databaseId: repo.id, name: repo.name };
}

function issueObject(repo: RepoRecord, issue: IssueRecord): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue, id: issueGlobalId(issue) };
}

function pullObject(repo: RepoRecord, pull: PullRecord): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull, id: pullGlobalId(pull) };
}

function commentObject(repo: RepoRecord, issue: IssueRecord, commentId: number, body: string): GqlObject {
  return { __typename: 'IssueComment', __repo: repo, __issue: issue, id: commentGlobalId(commentId), body };
}

function typeNameOf(source: GqlObject): string {
  return source.__typename;
}

function repoOf(source: GqlObject): RepoRecord {
  return source.__repo as RepoRecord;
}

function issueOf(source: GqlObject): IssueRecord {
  return source.__issue as IssueRecord;
}

function pullOf(source: GqlObject): PullRecord {
  return source.__pull as PullRecord;
}

function pullState(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueState(issue: IssueRecord): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------------------
// resolvers: one table per type. A resolver returns a scalar, a GraphQL object,
// an array of them, or null. Mutations write through the Store.
// ---------------------------------------------------------------------------

type Resolver = (env: ExecEnv, source: GqlObject, args: Record<string, unknown>) => unknown;

function identityField(field: string): Resolver {
  return (_env, source) => source[field] ?? null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerObject(),
    repository: (env, _source, args) => {
      const repo = env.store.getRepo(stringArg(args, 'owner'), stringArg(args, 'name'));
      return repo === null ? null : repoObject(repo);
    },
    node: (env, _source, args) => {
      const decoded = decodeGlobalId(stringArg(args, 'id'));
      if (decoded === null) return null;
      if (decoded.kind === 'repo') {
        const repo = findRepoByDatabaseId(env.store, decoded.id);
        return repo === null ? null : repoObject(repo);
      }
      if (decoded.kind === 'issue') {
        const found = findIssueById(env.store, decoded.id);
        return found === null ? null : issueObject(found.repo, found.issue);
      }
      if (decoded.kind === 'pull') {
        const found = findPullById(env.store, decoded.id);
        return found === null ? null : pullObject(found.repo, found.pull);
      }
      return null;
    },
    __type: (_env, _source, args) => {
      const name = stringArg(args, 'name');
      if (name === '') return null;
      const fields = TYPE_FIELDS[name];
      const enumValues = TYPE_ENUM_VALUES[name];
      if (fields === undefined && enumValues === undefined) return null;
      return {
        __typename: '__Type',
        name,
        kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
        __fields: fields ?? null,
        __enumValues: enumValues ?? null,
      };
    },
  },
  Mutation: {
    createIssue: (env, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      const repo = decoded !== null && decoded.kind === 'repo' ? findRepoByDatabaseId(env.store, decoded.id) : null;
      if (repo === null) {
        env.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return { __typename: 'CreateIssuePayload', __issue: null };
      }
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') {
        env.errors.push({ message: 'createIssue requires a title.' });
        return { __typename: 'CreateIssuePayload', __issue: null };
      }
      const issue = env.store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
      return { __typename: 'CreateIssuePayload', __repo: repo, __issue: issue };
    },
    closeIssue: (env, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
      const found = decoded !== null && decoded.kind === 'issue' ? findIssueById(env.store, decoded.id) : null;
      if (found === null) {
        env.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return { __typename: 'CloseIssuePayload', __issue: null };
      }
      const updated = env.store.updateIssue(found.repo, found.issue.number, { state: 'closed' });
      return { __typename: 'CloseIssuePayload', __repo: found.repo, __issue: updated ?? found.issue };
    },
    createPullRequest: (env, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      const repo = decoded !== null && decoded.kind === 'repo' ? findRepoByDatabaseId(env.store, decoded.id) : null;
      if (repo === null) {
        env.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return { __typename: 'CreatePullRequestPayload', __pull: null };
      }
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const headSha = env.store.resolveRef(repo, headRef);
      const baseSha = env.store.resolveRef(repo, baseRef);
      if (headSha === null || baseSha === null || headRef === '' || baseRef === '' || title === '') {
        env.errors.push({ message: 'createPullRequest requires existing head and base branches and a title.' });
        return { __typename: 'CreatePullRequestPayload', __pull: null };
      }
      const pull = env.store.createPull(repo, {
        title,
        body: typeof input.body === 'string' ? input.body : '',
        headRef,
        baseRef,
        headSha,
        baseSha,
      });
      return { __typename: 'CreatePullRequestPayload', __repo: repo, __pull: pull };
    },
    mergePullRequest: (env, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      const found = decoded !== null && decoded.kind === 'pull' ? findPullById(env.store, decoded.id) : null;
      if (found === null) {
        env.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        return { __typename: 'MergePullRequestPayload', __pull: null };
      }
      const mergeMethod = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      if (mergeMethod !== 'MERGE' && mergeMethod !== 'SQUASH' && mergeMethod !== 'REBASE') {
        env.errors.push({ message: `mergeMethod ${mergeMethod} is not supported.` });
        return { __typename: 'MergePullRequestPayload', __repo: found.repo, __pull: found.pull };
      }
      const message = `Merge pull request #${found.pull.number} from ${found.pull.headRef}\n\n${found.pull.title}`;
      const result = env.store.mergePull(found.repo, found.pull, message);
      if ('error' in result) {
        env.errors.push({ message: `Pull request #${found.pull.number} cannot be merged: ${result.error}.` });
        return { __typename: 'MergePullRequestPayload', __repo: found.repo, __pull: found.pull };
      }
      return { __typename: 'MergePullRequestPayload', __repo: found.repo, __pull: found.pull };
    },
    addComment: (env, _source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
      const found = decoded !== null && decoded.kind === 'issue' ? findIssueById(env.store, decoded.id) : null;
      const body = typeof input.body === 'string' ? input.body : '';
      if (found === null) {
        env.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return { __typename: 'AddCommentPayload', __comment: null };
      }
      if (body === '') {
        env.errors.push({ message: 'addComment requires a body.' });
        return { __typename: 'AddCommentPayload', __comment: null };
      }
      const comment = env.store.addComment(found.repo, found.issue.number, body);
      if (comment === null) {
        env.errors.push({ message: 'Could not add the comment.' });
        return { __typename: 'AddCommentPayload', __comment: null };
      }
      return {
        __typename: 'AddCommentPayload',
        __comment: commentObject(found.repo, found.issue, comment.id, comment.body),
      };
    },
  },
  Repository: {
    id: identityField('id'),
    databaseId: identityField('databaseId'),
    name: identityField('name'),
    nameWithOwner: (_env, source) => {
      const repo = repoOf(source);
      return `${repo.owner ?? VIEWER_LOGIN}/${repo.name}`;
    },
    owner: (_env, source) => {
      const repo = repoOf(source);
      return { __typename: 'User', id: `U_${repo.id}`, login: repo.owner ?? VIEWER_LOGIN };
    },
    defaultBranchRef: (_env, source) => {
      const repo = repoOf(source);
      const ref = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return ref === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_env, source) => repoOf(source).description,
    createdAt: (_env, source) => repoOf(source).createdAt,
    updatedAt: (_env, source) => repoOf(source).updatedAt,
    issue: (env, source, args) => {
      const repo = repoOf(source);
      const issue = env.store.getIssue(repo, intArg(args, 'number', 0));
      return issue === undefined ? null : issueObject(repo, issue);
    },
    issues: (env, source, args) => {
      const repo = repoOf(source);
      let issues = env.store.listIssues(repo);
      const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
      if (states.length > 0) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      const sorted = [...issues];
      if (field === 'UPDATED_AT') sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.createdSeq - b.createdSeq));
      else if (field === 'COMMENTS') sorted.sort((a, b) => a.comments.length - b.comments.length || a.createdSeq - b.createdSeq);
      else sorted.sort((a, b) => a.createdSeq - b.createdSeq);
      if (direction === 'DESC') sorted.reverse();
      const page = paginateItems(sorted, intArg(args, 'first', sorted.length), args.after);
      return {
        __typename: 'IssueConnection',
        nodes: page.nodes.map((issue) => issueObject(repo, issue)),
        pageInfo: page.pageInfo,
      };
    },
    pullRequests: (env, source, args) => {
      const repo = repoOf(source);
      const pulls = env.store.listPulls(repo).filter((pull) => pull.state === 'open');
      const sorted = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
      const page = paginateItems(sorted, intArg(args, 'first', sorted.length), args.after);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.nodes.map((pull) => pullObject(repo, pull)),
        pageInfo: page.pageInfo,
      };
    },
    pullRequest: (env, source, args) => {
      const repo = repoOf(source);
      const pull = env.store.getPull(repo, intArg(args, 'number', 0));
      return pull === undefined ? null : pullObject(repo, pull);
    },
  },
  User: {
    id: identityField('id'),
    login: identityField('login'),
  },
  Ref: {
    name: identityField('name'),
  },
  Issue: {
    id: identityField('id'),
    number: (_env, source) => issueOf(source).number,
    title: (_env, source) => issueOf(source).title,
    state: (_env, source) => issueState(issueOf(source)),
    body: (_env, source) => issueOf(source).body,
    createdAt: (_env, source) => issueOf(source).createdAt,
    updatedAt: (_env, source) => issueOf(source).updatedAt,
    closedAt: (_env, source) => issueOf(source).closedAt,
  },
  IssueConnection: {
    nodes: (_env, source) => (source.nodes as unknown[]),
    pageInfo: (_env, source) => source.pageInfo as GqlObject,
  },
  PageInfo: {
    hasNextPage: identityField('hasNextPage'),
    endCursor: identityField('endCursor'),
  },
  PullRequest: {
    id: identityField('id'),
    number: (_env, source) => pullOf(source).number,
    title: (_env, source) => pullOf(source).title,
    body: (_env, source) => pullOf(source).body,
    state: (_env, source) => pullState(pullOf(source)),
    merged: (_env, source) => pullOf(source).merged,
    headRefName: (_env, source) => pullOf(source).headRef,
    baseRefName: (_env, source) => pullOf(source).baseRef,
    mergeable: (env, source) => {
      const repo = repoOf(source);
      const pull = pullOf(source);
      if (pull.state !== 'open') return 'UNKNOWN';
      return env.store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (env, source, args) => {
      const repo = repoOf(source);
      const pull = pullOf(source);
      const changes = env.store.pullFiles(repo, pull);
      const page = paginateItems(changes, intArg(args, 'first', changes.length), args.after);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: page.nodes.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path })),
        pageInfo: page.pageInfo,
      };
    },
    createdAt: (_env, source) => pullOf(source).createdAt,
    updatedAt: (_env, source) => pullOf(source).updatedAt,
    closedAt: (_env, source) => pullOf(source).closedAt,
    mergedAt: (_env, source) => pullOf(source).mergedAt,
  },
  PullRequestConnection: {
    nodes: (_env, source) => (source.nodes as unknown[]),
    pageInfo: (_env, source) => source.pageInfo as GqlObject,
  },
  PullRequestChangedFileConnection: {
    nodes: (_env, source) => (source.nodes as unknown[]),
    pageInfo: (_env, source) => source.pageInfo as GqlObject,
  },
  PullRequestChangedFile: {
    path: identityField('path'),
  },
  IssueComment: {
    id: identityField('id'),
    body: identityField('body'),
  },
  IssueCommentEdge: {
    node: (_env, source) => (source.node as GqlObject | null),
  },
  CreateIssuePayload: {
    issue: (_env, source) => {
      const issue = source.__issue as IssueRecord | null;
      if (issue === null || issue === undefined) return null;
      return issueObject(source.__repo as RepoRecord, issue);
    },
  },
  CloseIssuePayload: {
    issue: (_env, source) => {
      const issue = source.__issue as IssueRecord | null;
      if (issue === null || issue === undefined) return null;
      return issueObject(source.__repo as RepoRecord, issue);
    },
  },
  CreatePullRequestPayload: {
    pullRequest: (_env, source) => {
      const pull = source.__pull as PullRecord | null;
      if (pull === null || pull === undefined) return null;
      return pullObject(source.__repo as RepoRecord, pull);
    },
  },
  MergePullRequestPayload: {
    pullRequest: (_env, source) => {
      const pull = source.__pull as PullRecord | null;
      if (pull === null || pull === undefined) return null;
      return pullObject(source.__repo as RepoRecord, pull);
    },
  },
  AddCommentPayload: {
    commentEdge: (_env, source) => {
      const comment = source.__comment as GqlObject | null;
      if (comment === null || comment === undefined) return null;
      return { __typename: 'IssueCommentEdge', node: comment };
    },
  },
  __Type: {
    name: identityField('name'),
    kind: identityField('kind'),
    fields: (_env, source) => {
      const fields = source.__fields as readonly string[] | null;
      if (fields === null) return null;
      return fields.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (_env, source) => {
      const values = source.__enumValues as readonly string[] | null;
      if (values === null) return null;
      return values.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: {
    name: identityField('name'),
  },
  __EnumValue: {
    name: identityField('name'),
  },
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

function executeSelectionSet(
  env: ExecEnv,
  typeName: string,
  source: GqlObject,
  selections: SelectionNode[],
  fragments: Record<string, SelectionNode[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = RESOLVERS[typeName] ?? {};
  const knownFields = new Set(TYPE_FIELDS[typeName] ?? []);
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = executeSelectionSet(env, typeName, source, selection.selections, fragments);
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments[selection.name];
      if (fragment === undefined) {
        env.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      const nested = executeSelectionSet(env, typeName, source, fragment, fragments);
      Object.assign(out, nested);
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    if (!knownFields.has(selection.name) || fields[selection.name] === undefined) {
      env.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const args = resolveArgs(selection.args, env.variables);
    let value: unknown;
    try {
      value = fields[selection.name]!(env, source, args);
    } catch (err) {
      env.errors.push({ message: err instanceof Error ? err.message : 'Internal error resolving a field.' });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(env, value, selection.selections, fragments);
  }
  return out;
}

/** Shape a resolved value against the field's sub-selections (scalars pass through). */
function completeValue(
  env: ExecEnv,
  value: unknown,
  selections: SelectionNode[],
  fragments: Record<string, SelectionNode[]>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(env, entry, selections, fragments));
  if (isRecord(value) && typeof value.__typename === 'string') {
    if (selections.length === 0) {
      // No sub-selections: return only the plain (non-internal) fields.
      const cleaned: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (key.startsWith('__')) continue;
        cleaned[key] = entry;
      }
      return cleaned;
    }
    return executeSelectionSet(env, value.__typename, value as GqlObject, selections, fragments);
  }
  return value;
}

function executeOperation(env: ExecEnv, document: DocumentNode, operationName: string | undefined): Record<string, unknown> {
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = document.operations.find((entry) => entry.name === operationName);
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    operation = document.operations.find((entry) => entry.kind === 'query') ?? document.operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: `Unknown operation named "${operationName ?? ''}".` }] };
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = executeSelectionSet(env, rootType, root, operation.selections, document.fragments);
  const body: Record<string, unknown> = { data };
  if (env.errors.length > 0) body.errors = env.errors;
  return body;
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

function runOne(store: Store, operation: unknown): Record<string, unknown> {
  const env: ExecEnv = { store, variables: {}, errors: [] };
  if (!isRecord(operation)) {
    return { data: null, errors: [{ message: 'Each GraphQL operation must be a JSON object with a query string.' }] };
  }
  const query = operation.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'A GraphQL query string is required.' }] };
  }
  if (operation.variables !== undefined && operation.variables !== null) {
    if (!isRecord(operation.variables)) {
      return { data: null, errors: [{ message: 'Variables must be a JSON object.' }] };
    }
    env.variables = operation.variables;
  }
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : undefined;
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'The document could not be parsed.' }] };
  }
  return executeOperation(env, document, operationName);
}

/** POST /api/graphql. `requestId` is the reply's X-GitHub-Request-Id value. */
export async function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  isAuthorized: boolean,
  requestId: string,
): Promise<void> {
  if (!isAuthorized) {
    jsonBody(res, 401, { message: 'Bad credentials' }, requestId);
    return;
  }
  if (req.method !== 'POST') {
    jsonBody(res, 404, { message: 'Not Found' }, requestId);
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    jsonBody(res, 400, { errors: [{ message: 'The request body could not be read.' }] }, requestId);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    jsonBody(res, 400, { errors: [{ message: 'The request body is not valid JSON.' }] }, requestId);
    return;
  }
  if (Array.isArray(parsed)) {
    jsonBody(res, 200, parsed.map((operation) => runOne(store, operation)), requestId);
    return;
  }
  jsonBody(res, 200, runOne(store, parsed), requestId);
}
