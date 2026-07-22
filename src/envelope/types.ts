// Envelope v2 — the 12-byte header wire format defined in
// docs/architecture-part1.md §1. This supersedes the 8-byte v1 layout in
// ../types.ts; the two coexist until the hosts are migrated (see docs/TODO.md).

/** Wire format version carried in header byte 0. */
export const ENVELOPE_VERSION = 2;

/** Fixed header size in bytes (Part I §1.2). */
export const HEADER_SIZE = 12;

/** Default maximum payload length a host allocates against (Part I §1.6). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB

/** `clientId = 0` means none / broadcast (Part I §1.3). */
export const CLIENT_ID_NONE = 0;

/** `clientId = 0xFFFF` is reserved for future use (Part I §1.3/§3.4). */
export const CLIENT_ID_RESERVED = 0xffff;

/** Bytes of framework-owned prefix on every Frame payload (Part I §1.4). */
export const FRAME_PREFIX_SIZE = 8; // frameSeq: u32 + sourceTick: u32

/** Delivery class carried in header byte 1 (Part I §1.4). */
export enum Channel {
  System = 0,
  App = 1,
  Frame = 2,
}

/** Framework control messages, valid only on the System channel (Part I §1.5). */
export enum SystemType {
  Init = 1,
  Join = 2,
  Ready = 3,
  Error = 4,
  Shutdown = 5,
  Leave = 6,
  Ping = 7,
  Pong = 8,
}

/** `Error` payload codes (Part I §1.5). */
export enum ErrorCode {
  Generic = 0,
  UnsupportedVersion = 1,
  UnknownVignette = 2,
  SessionFull = 3,
  NotProvisioned = 4,
  PeerFault = 5,
}

/** Reasons the strict decoder rejects a buffer; each maps to host behavior. */
export enum DecodeErrorReason {
  TooShort = 'TooShort',
  UnsupportedVersion = 'UnsupportedVersion',
  BadFlags = 'BadFlags',
  BadReserved = 'BadReserved',
  BadChannel = 'BadChannel',
  BadSystemType = 'BadSystemType',
  LengthMismatch = 'LengthMismatch',
  PayloadTooLarge = 'PayloadTooLarge',
}

/** The one error type the v2 decoder throws. No other throw escapes decode. */
export class EnvelopeDecodeError extends Error {
  readonly reason: DecodeErrorReason;
  constructor(reason: DecodeErrorReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'EnvelopeDecodeError';
    this.reason = reason;
  }
}

/** Maps a decode rejection to the System `Error` code a host should emit. */
export function errorCodeForDecodeReason(reason: DecodeErrorReason): ErrorCode {
  return reason === DecodeErrorReason.UnsupportedVersion
    ? ErrorCode.UnsupportedVersion
    : ErrorCode.Generic;
}

/** A decoded v2 envelope. `payload` is opaque for App/Frame. */
export interface Envelope {
  channel: Channel;
  /** Valid only when `channel === System`; otherwise 0. */
  systemType: number;
  /** Sender (host-bound) or target (peer-bound); see Part I §1.3. */
  clientId: number;
  payload: Uint8Array;
}
