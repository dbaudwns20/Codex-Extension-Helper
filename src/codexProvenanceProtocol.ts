export const CODEX_PROVENANCE_NOTIFICATION_COMMAND =
  'codexExtensionHelper.internal.codexProvenance';

export type CodexFileChangeKind =
  | { readonly type: 'add' }
  | { readonly type: 'delete' }
  | { readonly type: 'update'; readonly move_path: string | null };

export interface CodexFileUpdateChange {
  readonly path: string;
  readonly kind: CodexFileChangeKind;
  readonly diff: string;
}

export type CodexFileChangeStatus = 'completed' | 'failed' | 'declined' | 'interrupted';

export interface PatchUpdatedParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly changes: readonly CodexFileUpdateChange[];
}

export interface CompletedFileChangeParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly item: {
    readonly id: string;
    readonly type: 'fileChange';
    readonly status: CodexFileChangeStatus;
    readonly changes: readonly CodexFileUpdateChange[];
  };
}

export type CodexProvenanceNotification =
  | { readonly method: 'item/fileChange/patchUpdated'; readonly params: PatchUpdatedParams }
  | { readonly method: 'item/completed'; readonly params: CompletedFileChangeParams };

const DEFAULT_LIMITS = { maxChanges: 100, maxDiffBytes: 1024 * 1024 };
const TERMINAL_STATUSES = new Set<CodexFileChangeStatus>([
  'completed',
  'failed',
  'declined',
  'interrupted',
]);

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validPath(value: unknown): value is string {
  if (!nonEmptyString(value) || value.includes('\0') || value.includes('\\')) return false;
  if (/^[A-Za-z]:\//u.test(value)) return false;
  const segments = value.startsWith('/') ? value.slice(1).split('/') : value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function parseKind(value: unknown): CodexFileChangeKind | undefined {
  if (!plainObject(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'add' && exactKeys(value, ['type'])) return { type: 'add' };
  if (value.type === 'delete' && exactKeys(value, ['type'])) return { type: 'delete' };
  if (
    value.type === 'update'
    && exactKeys(value, ['type', 'move_path'])
    && (value.move_path === null || validPath(value.move_path))
  ) {
    return { type: 'update', move_path: value.move_path };
  }
  return undefined;
}

function parseChanges(value: unknown, limits: { maxChanges: number; maxDiffBytes: number }): readonly CodexFileUpdateChange[] | undefined {
  if (!Array.isArray(value) || value.length > limits.maxChanges) return undefined;
  const changes: CodexFileUpdateChange[] = [];
  for (const candidate of value) {
    if (!plainObject(candidate) || !exactKeys(candidate, ['path', 'kind', 'diff']) || !validPath(candidate.path) || typeof candidate.diff !== 'string') {
      return undefined;
    }
    if (Buffer.byteLength(candidate.diff, 'utf8') > limits.maxDiffBytes) return undefined;
    const kind = parseKind(candidate.kind);
    if (kind === undefined) return undefined;
    changes.push({ path: candidate.path, kind, diff: candidate.diff });
  }
  return changes;
}

function validLimits(limits: { maxChanges: number; maxDiffBytes: number }): boolean {
  return Number.isInteger(limits.maxChanges) && limits.maxChanges >= 0
    && Number.isInteger(limits.maxDiffBytes) && limits.maxDiffBytes >= 0;
}

export function parseCodexProvenanceNotification(
  value: unknown,
  limits: { maxChanges: number; maxDiffBytes: number } = DEFAULT_LIMITS,
): CodexProvenanceNotification | undefined {
  if (!validLimits(limits) || !plainObject(value)) return undefined;
  const hasEmittedAtMs = hasOwn(value, 'emittedAtMs');
  if (!exactKeys(value, hasEmittedAtMs ? ['method', 'params', 'emittedAtMs'] : ['method', 'params'])
    || (hasEmittedAtMs && !validTimestamp(value.emittedAtMs))) return undefined;
  if (value.method === 'item/fileChange/patchUpdated') {
    const params = value.params;
    if (!plainObject(params) || !exactKeys(params, ['threadId', 'turnId', 'itemId', 'changes'])
      || !nonEmptyString(params.threadId) || !nonEmptyString(params.turnId) || !nonEmptyString(params.itemId)) return undefined;
    const changes = parseChanges(params.changes, limits);
    return changes === undefined ? undefined : { method: value.method, params: { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, changes } };
  }
  if (value.method === 'item/completed') {
    const params = value.params;
    if (!plainObject(params)) return undefined;
    const hasCompletedAtMs = hasOwn(params, 'completedAtMs');
    if (!exactKeys(params, hasCompletedAtMs
      ? ['threadId', 'turnId', 'item', 'completedAtMs']
      : ['threadId', 'turnId', 'item'])
      || (hasCompletedAtMs && !validTimestamp(params.completedAtMs))
      || !nonEmptyString(params.threadId) || !nonEmptyString(params.turnId) || !plainObject(params.item)
      || !exactKeys(params.item, ['id', 'type', 'status', 'changes']) || !nonEmptyString(params.item.id)
      || params.item.type !== 'fileChange' || typeof params.item.status !== 'string'
      || !TERMINAL_STATUSES.has(params.item.status as CodexFileChangeStatus)) return undefined;
    const changes = parseChanges(params.item.changes, limits);
    return changes === undefined ? undefined : { method: value.method, params: { threadId: params.threadId, turnId: params.turnId, item: { id: params.item.id, type: 'fileChange', status: params.item.status as CodexFileChangeStatus, changes } } };
  }
  return undefined;
}
