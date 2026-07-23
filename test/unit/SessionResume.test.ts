// Client-side session resume (src/client/SessionResume): the ResumeCoordinator
// state machine and its token stores. Pure logic — no transport, no host.

import { describe, expect, test } from 'bun:test';

import {
  ResumeCoordinator,
  memoryTokenStore,
  webStorageTokenStore,
  type WebStorageLike,
  type ReadyPayload,
} from '../../src';
import { SystemType, decodeEnvelope, decodeInitPayload, decodeJoinPayload } from '../../src';

function ready(clientId: number, token: number[]): ReadyPayload {
  return { vignetteId: 'sim', version: '1.0.0', clientId, fixedStepUs: 16_666, resumeToken: new Uint8Array(token) };
}

/** A fake Web Storage area (Map-backed) for the browser store. */
function fakeStorage(): WebStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('ResumeCoordinator', () => {
  test('opens with Init when no token is stored', () => {
    const c = new ResumeCoordinator('sim', memoryTokenStore());
    const env = decodeEnvelope(c.opening(new TextEncoder().encode('{}')));
    expect(env.systemType).toBe(SystemType.Init);
    expect(decodeInitPayload(env.payload)!.vignetteId).toBe('sim');
  });

  test('opens with a resume-Join once a token is stored', () => {
    const store = memoryTokenStore();
    const c = new ResumeCoordinator('sim', store);
    c.onReady(ready(1, [9, 8, 7])); // persists id 1 + token
    const env = decodeEnvelope(c.opening());
    expect(env.systemType).toBe(SystemType.Join);
    const join = decodeJoinPayload(env.payload)!;
    expect(join.vignetteId).toBe('sim');
    expect(Array.from(join.resumeToken ?? [])).toEqual([9, 8, 7]);
  });

  test('onReady reports resumed=false on first connect, true when the id is unchanged', () => {
    const c = new ResumeCoordinator('sim', memoryTokenStore());
    expect(c.onReady(ready(1, [1])).resumed).toBe(false); // fresh session
    expect(c.onReady(ready(1, [2])).resumed).toBe(true); // same id → a real resume
  });

  test('onReady reports resumed=false when the host mints a new id (expired token)', () => {
    const c = new ResumeCoordinator('sim', memoryTokenStore());
    c.onReady(ready(1, [1]));
    const r = c.onReady(ready(5, [2])); // different id → fell back to a fresh session
    expect(r.resumed).toBe(false);
    // …and the coordinator now tracks the new id.
    expect(c.onReady(ready(5, [3])).resumed).toBe(true);
  });

  test('reset forgets the session, so the next open is a fresh Init', () => {
    const c = new ResumeCoordinator('sim', memoryTokenStore());
    c.onReady(ready(1, [1]));
    c.reset();
    expect(decodeEnvelope(c.opening()).systemType).toBe(SystemType.Init);
  });

  test('webStorageTokenStore round-trips a record through string storage', () => {
    const storage = fakeStorage();
    const store = webStorageTokenStore('room:demo', storage);
    store.save({ clientId: 7, token: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) });
    expect(storage.map.has('room:demo')).toBe(true); // actually persisted as a string

    const loaded = store.load()!;
    expect(loaded.clientId).toBe(7);
    expect(Array.from(loaded.token)).toEqual([0xde, 0xad, 0xbe, 0xef]);

    store.clear();
    expect(store.load()).toBeNull();
  });

  test('webStorageTokenStore survives a "reload" — a new store reads the prior token', () => {
    const storage = fakeStorage(); // the storage area outlives the store instance, like sessionStorage a reload
    webStorageTokenStore('r', storage).save({ clientId: 3, token: new Uint8Array([1, 2]) });
    // New coordinator + new store over the same storage → opens with a resume-Join.
    const c = new ResumeCoordinator('sim', webStorageTokenStore('r', storage));
    expect(decodeEnvelope(c.opening()).systemType).toBe(SystemType.Join);
  });
});
