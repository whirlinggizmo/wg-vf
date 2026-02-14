import { type VignetteType, isVignetteType } from '../VignetteTypes';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ReadyPayload {
  ready: boolean;
  vignetteType: VignetteType;
}

export interface ErrorPayload {
  message: string;
  code?: string;
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
