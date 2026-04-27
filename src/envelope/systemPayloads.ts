import { type VignetteType, isVignetteType } from '../vignettes/Vignette';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PING_PAYLOAD_SIZE = 12;

export interface ReadyPayload {
  ready: boolean;
  vignetteType: VignetteType;
}

export interface ErrorPayload {
  message: string;
  code?: string;
}

export interface PingPayload {
  sequence: number;
  sentAtMs: number;
}

function encodeJson(payload: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(payload));
}

function decodeJson(payload: Uint8Array): unknown | null {
  if (payload.length === 0) {
    return null;
  }

  try {
    return JSON.parse(textDecoder.decode(payload));
  } catch {
    return null;
  }
}

export function encodeReadyPayload(payload: ReadyPayload): Uint8Array {
  return encodeJson(payload);
}

export function decodeReadyPayload(payload: Uint8Array): ReadyPayload | null {
  const parsed = decodeJson(payload);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const candidate = parsed as Partial<ReadyPayload>;
  if (typeof candidate.ready !== 'boolean') {
    return null;
  }

  if (!isVignetteType(candidate.vignetteType)) {
    return null;
  }

  return { ready: candidate.ready, vignetteType: candidate.vignetteType };
}

export function encodeErrorPayload(payload: ErrorPayload): Uint8Array {
  return encodeJson(payload);
}

export function decodeErrorPayload(payload: Uint8Array): ErrorPayload | null {
  const parsed = decodeJson(payload);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const candidate = parsed as Partial<ErrorPayload>;
  if (typeof candidate.message !== 'string') {
    return null;
  }

  if (candidate.code !== undefined && typeof candidate.code !== 'string') {
    return null;
  }

  return {
    message: candidate.message,
    code: candidate.code,
  };
}

export function encodePingPayload(payload: PingPayload): Uint8Array {
  const bytes = new Uint8Array(PING_PAYLOAD_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, payload.sequence >>> 0, true);
  view.setFloat64(4, payload.sentAtMs, true);
  return bytes;
}

export function decodePingPayload(payload: Uint8Array): PingPayload | null {
  if (payload.length !== PING_PAYLOAD_SIZE) {
    return null;
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    sequence: view.getUint32(0, true),
    sentAtMs: view.getFloat64(4, true),
  };
}
