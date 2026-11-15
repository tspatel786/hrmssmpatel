// Backend abstraction: the UI talks only to this interface.
// Implementations: Supabase (production) and Local (PGlite in-browser demo / tests).

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'ilike' | 'is' | 'contains';

export interface Filter {
  column: string;
  op: FilterOp;
  value: unknown;
}

export interface ListQuery {
  table: string;
  columns?: string; // comma separated column list, default '*'
  filters?: Filter[];
  search?: { columns: string[]; term: string };
  order?: { column: string; ascending?: boolean }[];
  range?: [number, number]; // inclusive, like supabase .range()
  count?: boolean;
}

export interface ListResult<T> {
  rows: T[];
  count: number;
}

export interface DbApi {
  list<T = Record<string, unknown>>(q: ListQuery): Promise<ListResult<T>>;
  get<T = Record<string, unknown>>(table: string, id: string, column?: string): Promise<T | null>;
  insert<T = Record<string, unknown>>(table: string, values: Record<string, unknown>): Promise<T>;
  insertMany(table: string, values: Record<string, unknown>[]): Promise<void>;
  update<T = Record<string, unknown>>(table: string, id: string, values: Record<string, unknown>, column?: string): Promise<T>;
  remove(table: string, id: string, column?: string): Promise<void>;
  removeWhere(table: string, filters: Filter[]): Promise<void>;
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
}

export interface StorageApi {
  upload(bucket: string, path: string, file: Blob, contentType?: string): Promise<void>;
  download(bucket: string, path: string): Promise<Blob>;
  signedUrl(bucket: string, path: string, expiresInSeconds?: number): Promise<string>;
  publicUrl(bucket: string, path: string): Promise<string>;
  remove(bucket: string, path: string): Promise<void>;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName?: string;
}

export interface AuthApi {
  getUser(): Promise<AuthUser | null>;
  onChange(cb: (user: AuthUser | null) => void): () => void;
  signIn(email: string, password: string): Promise<AuthUser>;
  signUp(email: string, password: string, fullName: string): Promise<{ user: AuthUser | null; needsConfirmation: boolean }>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  updatePassword(newPassword: string): Promise<void>;
}

export interface Backend {
  mode: 'supabase' | 'demo';
  auth: AuthApi;
  db: DbApi;
  storage: StorageApi;
  /** Ask the server-side worker to deliver queued emails (fire-and-forget safe). */
  processEmails(): Promise<void>;
}

export class BackendError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
export function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new BackendError(`Invalid identifier: ${name}`);
  return name;
}

/** Turn raw Postgres/PostgREST errors into user-friendly messages. */
export function friendlyError(message: string, code?: string): BackendError {
  let msg = message || 'Something went wrong';
  if (/row-level security|permission denied for /i.test(msg)) {
    // built-in Postgres messages leak table names; our own guard messages are kept as-is
    msg = 'You do not have permission to perform this action.';
  } else if (code === '23505' || /duplicate key value/i.test(msg)) {
    if (!/already/i.test(msg)) msg = 'A record with these details already exists.';
  } else if (code === '23503' || /violates foreign key/i.test(msg)) {
    msg = /is still referenced/i.test(msg)
      ? 'This record is in use by other records and cannot be deleted.'
      : 'A referenced record does not exist.';
  } else if (code === '23514' || /violates check constraint/i.test(msg)) {
    msg = 'Some values are invalid. Please review the form.';
  } else if (/JWT expired/i.test(msg)) {
    msg = 'Your session has expired. Please sign in again.';
  }
  return new BackendError(msg, code);
}
