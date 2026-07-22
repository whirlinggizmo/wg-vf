// Binary System-message payloads for envelope v2 (Part I §1.5). All System
// payloads are binary in v2 — the v1 JSON forms for Ready/Error are dropped.
// Decoders return null on malformed input (a payload-level concern the host
// turns into an Error), never throw.

import { ErrorCode } from './types.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeLenPrefixed(parts: number[], bytes: Uint8Array): void {
  // Helper builds a growable number[] then callers pack; kept simple/explicit.
  parts.push(
    bytes.length & 0xff,
    (bytes.length >>> 8) & 0xff,
    (bytes.length >>> 16) & 0xff,
    (bytes.length >>> 24) & 0xff,
  );
  for (const b of bytes) parts.push(b);
}

function readLenPrefixed(
  payload: Uint8Array,
  offset: number,
): { bytes: Uint8Array; next: number } | null {
  if (offset + 4 > payload.length) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const len = view.getUint32(offset, true);
  const start = offset + 4;
  if (start + len > payload.length) return null;
  return { bytes: payload.slice(start, start + len), next: start + len };
}

// ---------------------------------------------------------------------------
// Init (peer → host): vignetteId string, followed by opaque init bytes.
// ---------------------------------------------------------------------------

export interface InitPayload {
  vignetteId: string;
  initPayload: Uint8Array;
}

export function encodeInitPayload(p: InitPayload): Uint8Array {
  const parts: number[] = [];
  writeLenPrefixed(parts, textEncoder.encode(p.vignetteId));
  const head = Uint8Array.from(parts);
  const out = new Uint8Array(head.length + p.initPayload.length);
  out.set(head, 0);
  out.set(p.initPayload, head.length);
  return out;
}

export function decodeInitPayload(payload: Uint8Array): InitPayload | null {
  const id = readLenPrefixed(payload, 0);
  if (id === null) return null;
  return { vignetteId: textDecoder.decode(id.bytes), initPayload: payload.slice(id.next) };
}

// ---------------------------------------------------------------------------
// Join (peer → host): vignetteId string, optional resumeToken bytes.
// ---------------------------------------------------------------------------

export interface JoinPayload {
  vignetteId: string;
  resumeToken?: Uint8Array;
}

export function encodeJoinPayload(p: JoinPayload): Uint8Array {
  const parts: number[] = [];
  writeLenPrefixed(parts, textEncoder.encode(p.vignetteId));
  writeLenPrefixed(parts, p.resumeToken ?? new Uint8Array(0));
  return Uint8Array.from(parts);
}

export function decodeJoinPayload(payload: Uint8Array): JoinPayload | null {
  const id = readLenPrefixed(payload, 0);
  if (id === null) return null;
  const token = readLenPrefixed(payload, id.next);
  if (token === null) return null;
  const result: JoinPayload = { vignetteId: textDecoder.decode(id.bytes) };
  if (token.bytes.length > 0) result.resumeToken = token.bytes;
  return result;
}

// ---------------------------------------------------------------------------
// Ready (host → peer): resolved id, version, assigned clientId, fixedStepUs.
// ---------------------------------------------------------------------------

export interface ReadyPayload {
  vignetteId: string;
  version: string;
  clientId: number;
  fixedStepUs: number;
  /** Bearer token for reconnect (Part I §3.3); empty if reconnect is disabled. */
  resumeToken: Uint8Array;
}

export function encodeReadyPayload(p: ReadyPayload): Uint8Array {
  const parts: number[] = [];
  writeLenPrefixed(parts, textEncoder.encode(p.vignetteId));
  writeLenPrefixed(parts, textEncoder.encode(p.version));
  const head = Uint8Array.from(parts);
  const token = p.resumeToken;
  const out = new Uint8Array(head.length + 10 + token.length);
  out.set(head, 0);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(head.length, p.clientId >>> 0, true);
  view.setUint32(head.length + 2, p.fixedStepUs >>> 0, true);
  view.setUint32(head.length + 6, token.length, true);
  out.set(token, head.length + 10);
  return out;
}

export function decodeReadyPayload(payload: Uint8Array): ReadyPayload | null {
  const id = readLenPrefixed(payload, 0);
  if (id === null) return null;
  const ver = readLenPrefixed(payload, id.next);
  if (ver === null) return null;
  const off = ver.next;
  if (off + 10 > payload.length) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const tokenLen = view.getUint32(off + 6, true);
  if (off + 10 + tokenLen !== payload.length) return null;
  return {
    vignetteId: textDecoder.decode(id.bytes),
    version: textDecoder.decode(ver.bytes),
    clientId: view.getUint16(off, true),
    fixedStepUs: view.getUint32(off + 2, true),
    resumeToken: payload.slice(off + 10),
  };
}

// ---------------------------------------------------------------------------
// Error (host → peer): code u16, message string.
// ---------------------------------------------------------------------------

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

export function encodeErrorPayload(p: ErrorPayload): Uint8Array {
  const msg = textEncoder.encode(p.message);
  const out = new Uint8Array(2 + 4 + msg.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(0, p.code >>> 0, true);
  view.setUint32(2, msg.length, true);
  out.set(msg, 6);
  return out;
}

export function decodeErrorPayload(payload: Uint8Array): ErrorPayload | null {
  if (payload.length < 6) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const code = view.getUint16(0, true);
  const msgLen = view.getUint32(2, true);
  if (6 + msgLen !== payload.length) return null;
  return { code, message: textDecoder.decode(payload.slice(6)) };
}

// ---------------------------------------------------------------------------
// Ping / Pong: sequence u32, sentAtMs f64 (unchanged from v1).
// ---------------------------------------------------------------------------

export interface PingPayload {
  sequence: number;
  sentAtMs: number;
}

const PING_SIZE = 12;

export function encodePingPayload(p: PingPayload): Uint8Array {
  const out = new Uint8Array(PING_SIZE);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, p.sequence >>> 0, true);
  view.setFloat64(4, p.sentAtMs, true);
  return out;
}

export function decodePingPayload(payload: Uint8Array): PingPayload | null {
  if (payload.length !== PING_SIZE) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { sequence: view.getUint32(0, true), sentAtMs: view.getFloat64(4, true) };
}
