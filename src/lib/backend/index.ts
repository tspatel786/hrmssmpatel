import { config } from '../config';
import type { Backend } from './types';

let instance: Promise<Backend> | null = null;
let resolved: Backend | null = null;

/** Lazily creates the backend. The demo backend (PGlite, ~3MB wasm) is only loaded in demo mode. */
export function getBackend(): Promise<Backend> {
  if (!instance) {
    instance = (
      config.mode === 'supabase'
        ? import('./supabase').then((m) => m.createSupabaseBackend(config.supabaseUrl, config.supabaseAnonKey))
        : import('./local').then((m) => m.createLocalBackend())
    ).then((b) => {
      resolved = b;
      return b;
    });
    instance.catch(() => {
      instance = null;
    });
  }
  return instance;
}

export function setResolvedBackend(b: Backend) {
  resolved = b;
}

/** Synchronous access after the app has booted (AppBoot awaits getBackend()). */
export function getBackendSync(): Backend {
  if (!resolved) throw new Error('Backend not initialised');
  return resolved;
}

export const api = {
  get db() {
    return getBackendSync().db;
  },
  get storage() {
    return getBackendSync().storage;
  },
  get auth() {
    return getBackendSync().auth;
  },
  get mode() {
    return getBackendSync().mode;
  },
  processEmails: () => getBackendSync().processEmails().catch(() => undefined),
};
