// Client-side session resume (Part I §3.3). A small state helper so an app can
// survive a transport drop *or a full page reload* without losing its clientId:
// it persists the resumeToken from each Ready and, on the next connect, opens
// with a resume-Join instead of a fresh Init.
//
// The framework owns neither the transport nor storage — you drive the socket;
// this decides the opening envelope and tracks the token lifecycle through a
// pluggable TokenStore. Back it with sessionStorage in a browser (survives
// reload, dies with the tab) — a bearer token should not outlive its tab.
//
// The reconnect only succeeds while the host still holds the id in reconnect
// grace (reconnectGraceMs) and the session is alive (emptyGraceMs); set those
// windows wide enough to bracket a realistic reload/network transition, or the
// resume falls back to a fresh session.

import {
  SystemType,
  encodeSystemEnvelope,
  encodeInitPayload,
  encodeJoinPayload,
  type ReadyPayload,
} from '../envelope/index.js';

export interface SessionRecord {
  clientId: number;
  token: Uint8Array;
}

export interface TokenStore {
  load(): SessionRecord | null;
  save(record: SessionRecord): void;
  clear(): void;
}

/** In-memory store — survives reconnects within one page/process, not a reload. */
export function memoryTokenStore(): TokenStore {
  let record: SessionRecord | null = null;
  return {
    load: () => record,
    save: (r) => {
      record = r;
    },
    clear: () => {
      record = null;
    },
  };
}

/** The subset of the Web Storage API this needs (sessionStorage/localStorage). */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Store backed by a Web Storage area. In a browser pass `window.sessionStorage`
 * (recommended — tab-scoped, cleared on tab close) or `localStorage`. `key`
 * should be unique per room so distinct sessions don't collide.
 */
export function webStorageTokenStore(key: string, storage: WebStorageLike): TokenStore {
  return {
    load: () => {
      const raw = storage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { clientId: number; token: string };
        return { clientId: parsed.clientId, token: hexToBytes(parsed.token) };
      } catch {
        return null;
      }
    },
    save: (r) => storage.setItem(key, JSON.stringify({ clientId: r.clientId, token: bytesToHex(r.token) })),
    clear: () => storage.removeItem(key),
  };
}

/**
 * Tracks the resume token across connects. Drive it from your transport:
 *   - send `opening()` as the first envelope after the socket opens;
 *   - call `onReady(ready)` for every Ready — it persists the fresh token and
 *     tells you whether this was a resume (same id) or a fresh session;
 *   - call `reset()` on an Error/Shutdown that ends the session.
 */
export class ResumeCoordinator {
  constructor(
    private readonly vignetteId: string,
    private readonly store: TokenStore,
  ) {}

  /** The first envelope to send: a resume-Join if we hold a token, else Init. */
  opening(initPayload: Uint8Array = new Uint8Array()): Uint8Array {
    const saved = this.store.load();
    if (saved && saved.token.length > 0) {
      return encodeSystemEnvelope(
        SystemType.Join,
        encodeJoinPayload({ vignetteId: this.vignetteId, resumeToken: saved.token }),
      );
    }
    return encodeSystemEnvelope(SystemType.Init, encodeInitPayload({ vignetteId: this.vignetteId, initPayload }));
  }

  /**
   * Record the token from a Ready. Returns `{ resumed }`: true if the host gave
   * back the same clientId we last held (a real resume), false if this is a
   * fresh session — first connect, or the token had expired and the host minted
   * a new id, in which case the app should reset any per-session local state.
   * (Ids are never reused, so a post-expiry Join can't collide with the old id.)
   */
  onReady(ready: ReadyPayload): { resumed: boolean } {
    const prior = this.store.load();
    const resumed = prior != null && prior.clientId === ready.clientId;
    this.store.save({ clientId: ready.clientId, token: ready.resumeToken });
    return { resumed };
  }

  /** Forget the session (call when an Error/Shutdown ends it, or on logout). */
  reset(): void {
    this.store.clear();
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
