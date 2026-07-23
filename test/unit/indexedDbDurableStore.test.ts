// indexedDbDurableStore: the browser/worker durable backend. Tested against a
// compact in-memory IndexedDB fake (no dependency, no real browser) that mimics
// the request/transaction event flow the store relies on.

import { describe, expect, test } from 'bun:test';

import { indexedDbDurableStore } from '../../src';

/** Minimal in-memory IDBFactory — just the surface indexedDbDurableStore uses. */
function fakeIndexedDB(): IDBFactory {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();
  const soon = (fn: unknown) => queueMicrotask(() => typeof fn === 'function' && (fn as () => void)());

  const factory = {
    open(name: string) {
      const isNew = !dbs.has(name);
      if (isNew) dbs.set(name, new Map());
      const stores = dbs.get(name)!;
      const db = {
        objectStoreNames: { contains: (s: string) => stores.has(s) },
        createObjectStore: (s: string) => stores.set(s, new Map()),
        transaction: (s: string) => {
          const store = stores.get(s)!;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tx: any = { error: null, oncomplete: null, onerror: null, onabort: null };
          tx.objectStore = () => ({
            get: (k: string) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                req.result = store.get(k);
                soon(req.onsuccess);
              });
              return req;
            },
            put: (v: unknown, k: string) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const req: any = { result: k, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                store.set(k, v);
                soon(tx.oncomplete);
              });
              return req;
            },
            delete: (k: string) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                store.delete(k);
                soon(tx.oncomplete);
              });
              return req;
            },
          });
          return tx;
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const openReq: any = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (isNew) soon(openReq.onupgradeneeded);
        soon(openReq.onsuccess);
      });
      return openReq;
    },
  };
  return factory as unknown as IDBFactory;
}

describe('indexedDbDurableStore', () => {
  test('save/load/remove round-trip, and a fresh store over the same DB restores it (a reload)', async () => {
    const idb = fakeIndexedDB();
    const s1 = indexedDbDurableStore({ indexedDB: idb });
    await s1.save('sim/slot1', new Uint8Array([1, 2, 3]));
    expect(Array.from((await s1.load('sim/slot1'))!)).toEqual([1, 2, 3]);

    const s2 = indexedDbDurableStore({ indexedDB: idb }); // as after a page reload
    expect(Array.from((await s2.load('sim/slot1'))!)).toEqual([1, 2, 3]);
    expect(await s2.load('sim/absent')).toBeNull();

    await s2.remove('sim/slot1');
    expect(await s2.load('sim/slot1')).toBeNull();
  });

  test('scopes are independent', async () => {
    const s = indexedDbDurableStore({ indexedDB: fakeIndexedDB() });
    await s.save('a', new Uint8Array([1]));
    await s.save('b', new Uint8Array([2]));
    expect(Array.from((await s.load('a'))!)).toEqual([1]);
    expect(Array.from((await s.load('b'))!)).toEqual([2]);
  });

  test('the stored blob is a copy — later caller mutation cannot reach it', async () => {
    const s = indexedDbDurableStore({ indexedDB: fakeIndexedDB() });
    const buf = new Uint8Array([9]);
    await s.save('k', buf);
    buf[0] = 0;
    expect(Array.from((await s.load('k'))!)).toEqual([9]);
  });

  test('throws when no IndexedDB is available and none is injected', () => {
    expect(() => indexedDbDurableStore()).toThrow(/no IndexedDB/);
  });
});
