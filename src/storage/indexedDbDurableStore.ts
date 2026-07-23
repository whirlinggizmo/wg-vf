// IndexedDB-backed DurableStore — the browser/worker durable backend for
// vignette storage. IndexedDB is available in both windows and Web Workers
// (where a worker-hosted vignette runs), and survives reloads and tab restarts,
// which is exactly what session-resume-across-reload needs.
//
// It stores one whole-mount blob per scope (key = scope, value = the archive
// bytes). Writes resolve on transaction *completion* (not just request success),
// so a `flush()` genuinely means "durable" before it resolves. The IDBFactory is
// injectable so this is testable without a real browser.

import type { DurableStore } from './VignetteStorage.js';

export interface IndexedDbDurableStoreOptions {
  /** Database name. Default `'wg-vf'`. */
  dbName?: string;
  /** Object store name. Default `'vignette-storage'`. */
  storeName?: string;
  /** IDBFactory to use; defaults to the global `indexedDB`. Inject for tests. */
  indexedDB?: IDBFactory;
}

/** A DurableStore backed by IndexedDB (browser/worker). */
export function indexedDbDurableStore(options: IndexedDbDurableStoreOptions = {}): DurableStore {
  const dbName = options.dbName ?? 'wg-vf';
  const storeName = options.storeName ?? 'vignette-storage';
  const idb = options.indexedDB ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  if (!idb) {
    throw new Error('indexedDbDurableStore: no IndexedDB available (browser/worker only, or pass one in)');
  }

  let dbPromise: Promise<IDBDatabase> | null = null;
  const openDb = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = idb.open(dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
      });
    }
    return dbPromise;
  };

  // A read resolves with the request's result; a write resolves on transaction
  // completion so the caller's flush() only returns once the data is durable.
  const run = async <T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest,
    result: (req: IDBRequest) => T,
  ): Promise<T> => {
    const db = await openDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = op(tx.objectStore(storeName));
      if (mode === 'readonly') {
        req.onsuccess = () => resolve(result(req));
        req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'));
      } else {
        tx.oncomplete = () => resolve(result(req));
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB write aborted'));
      }
    });
  };

  return {
    load: (scope) =>
      run<Uint8Array | null>(
        'readonly',
        (s) => s.get(scope),
        (req) => {
          const val = req.result as unknown;
          if (val instanceof Uint8Array) return val;
          if (val instanceof ArrayBuffer) return new Uint8Array(val);
          return null;
        },
      ),
    save: (scope, bytes) =>
      run<void>(
        'readwrite',
        (s) => s.put(bytes.slice(), scope), // copy so later mutation can't reach the stored blob
        () => undefined,
      ),
    remove: (scope) =>
      run<void>(
        'readwrite',
        (s) => s.delete(scope),
        () => undefined,
      ),
  };
}
