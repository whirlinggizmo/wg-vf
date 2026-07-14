import type { VignetteType } from '../vignettes/Vignette.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Payload sizes
const PING_PAYLOAD_SIZE = 12; // sequence: u32 + sentAtMs: f64
const READY_PAYLOAD_SIZE = 2; // ready: u8 + vignetteType: u8

// Vignette type enum values for binary encoding
const VIGNETTE_TYPE_JS = 0;
const VIGNETTE_TYPE_WASM = 1;

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

export interface InitPayload {
  vignetteType: VignetteType;
  vignetteUrl: string;
  initPayload: Uint8Array;
}

function vignetteTypeToByte(type: VignetteType): number {
  return type === 'js' ? VIGNETTE_TYPE_JS : VIGNETTE_TYPE_WASM;
}

function byteToVignetteType(byte: number): VignetteType | null {
  if (byte === VIGNETTE_TYPE_JS) return 'js';
  if (byte === VIGNETTE_TYPE_WASM) return 'wasm';
  return null;
}

function encodeLengthPrefixedString(str: string): Uint8Array {
  const bytes = textEncoder.encode(str);
  const result = new Uint8Array(4 + bytes.length);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(0, bytes.length, true);
  result.set(bytes, 4);
  return result;
}

function decodeLengthPrefixedString(
  payload: Uint8Array,
  offset: number,
): { str: string; nextOffset: number } | null {
  if (payload.length < offset + 4) {
    return null;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const length = view.getUint32(offset, true);
  if (payload.length < offset + 4 + length) {
    return null;
  }
  const bytes = payload.slice(offset + 4, offset + 4 + length);
  return { str: textDecoder.decode(bytes), nextOffset: offset + 4 + length };
}

// Ready payload binary format:
// byte 0: ready flag (0 or 1)
// byte 1: vignette type (0 = js, 1 = wasm)

export function encodeReadyPayload(payload: ReadyPayload): Uint8Array {
  const bytes = new Uint8Array(READY_PAYLOAD_SIZE);
  bytes[0] = payload.ready ? 1 : 0;
  bytes[1] = vignetteTypeToByte(payload.vignetteType);
  return bytes;
}

export function decodeReadyPayload(payload: Uint8Array): ReadyPayload | null {
  if (payload.length !== READY_PAYLOAD_SIZE) {
    return null;
  }

  const ready = payload[0] === 1;
  const vignetteType = byteToVignetteType(payload[1]);

  if (vignetteType === null) {
    return null;
  }

  return { ready, vignetteType };
}

// Error payload binary format:
// bytes 0-3: message length (u32 LE)
// bytes 4..(4+messageLen-1): message UTF-8 bytes
// byte (4+messageLen): hasCode flag (u8: 0 or 1)
// if hasCode:
//   bytes (5+messageLen)..(5+messageLen+3): code length (u32 LE)
//   bytes (9+messageLen)..: code UTF-8 bytes

export function encodeErrorPayload(payload: ErrorPayload): Uint8Array {
  const messageBytes = encodeLengthPrefixedString(payload.message);

  if (payload.code === undefined) {
    const result = new Uint8Array(messageBytes.length + 1);
    result.set(messageBytes, 0);
    result[messageBytes.length] = 0; // hasCode = false
    return result;
  }

  const codeBytes = encodeLengthPrefixedString(payload.code);
  const result = new Uint8Array(messageBytes.length + 1 + codeBytes.length);
  result.set(messageBytes, 0);
  result[messageBytes.length] = 1; // hasCode = true
  result.set(codeBytes, messageBytes.length + 1);
  return result;
}

export function decodeErrorPayload(payload: Uint8Array): ErrorPayload | null {
  const messageResult = decodeLengthPrefixedString(payload, 0);
  if (messageResult === null) {
    return null;
  }

  const { str: message, nextOffset } = messageResult;

  if (payload.length < nextOffset + 1) {
    return null;
  }

  const hasCode = payload[nextOffset] === 1;
  if (!hasCode) {
    return { message };
  }

  const codeResult = decodeLengthPrefixedString(payload, nextOffset + 1);
  if (codeResult === null) {
    return null;
  }

  return { message, code: codeResult.str };
}

// Ping payload binary format (unchanged):
// bytes 0-3: sequence (u32 LE)
// bytes 4-11: sentAtMs (f64 LE)

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

// Init payload binary format (variable length):
// byte 0: vignetteType (0 = js, 1 = wasm)
// bytes 1-4: vignetteUrl length (u32 LE)
// bytes 5..(5+vignetteUrlLen-1): vignetteUrl UTF-8 bytes
// bytes (5+vignetteUrlLen)..(5+vignetteUrlLen+3): initPayloadLen (u32 LE)
// bytes (9+vignetteUrlLen)..: initPayload bytes

export function encodeInitPayload(payload: InitPayload): Uint8Array {
  const vignetteUrlBytes = textEncoder.encode(payload.vignetteUrl);
  const headerSize = 1 + 4 + vignetteUrlBytes.length + 4;
  const result = new Uint8Array(headerSize + payload.initPayload.length);

  result[0] = vignetteTypeToByte(payload.vignetteType);

  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(1, vignetteUrlBytes.length, true);
  result.set(vignetteUrlBytes, 5);
  view.setUint32(5 + vignetteUrlBytes.length, payload.initPayload.length, true);
  result.set(payload.initPayload, 9 + vignetteUrlBytes.length);

  return result;
}

export function decodeInitPayload(payload: Uint8Array): InitPayload | null {
  if (payload.length < 9) {
    return null;
  }

  const vignetteType = byteToVignetteType(payload[0]);
  if (vignetteType === null) {
    return null;
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const vignetteUrlLen = view.getUint32(1, true);

  if (payload.length < 9 + vignetteUrlLen) {
    return null;
  }

  const vignetteUrlBytes = payload.slice(5, 5 + vignetteUrlLen);
  const vignetteUrl = textDecoder.decode(vignetteUrlBytes);

  const initPayloadLen = view.getUint32(5 + vignetteUrlLen, true);

  if (payload.length !== 9 + vignetteUrlLen + initPayloadLen) {
    return null;
  }

  const initPayload = payload.slice(9 + vignetteUrlLen);

  return { vignetteType, vignetteUrl, initPayload };
}
