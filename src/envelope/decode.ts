// Envelope v2 strict decoder (Part I §1.2–§1.6). Rejection is total: the only
// throw that escapes is EnvelopeDecodeError. The payload cap and the length
// check are applied BEFORE the payload body is read, so a hostile buffer can
// never provoke an over-read or an oversized allocation (ENV-08, ENV-25).

import {
  Channel,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DecodeErrorReason,
  ENVELOPE_VERSION,
  EnvelopeDecodeError,
  FRAME_PREFIX_SIZE,
  HEADER_SIZE,
  SystemType,
  type Envelope,
} from './types.js';

export interface DecodeOptions {
  /** Reject payloads longer than this before allocating (Part I §1.6). */
  maxPayloadBytes?: number;
}

const KNOWN_CHANNELS = new Set<number>([Channel.System, Channel.App, Channel.Frame]);
const KNOWN_SYSTEM_TYPES = new Set<number>([
  SystemType.Init,
  SystemType.Join,
  SystemType.Ready,
  SystemType.Error,
  SystemType.Shutdown,
  SystemType.Leave,
  SystemType.Ping,
  SystemType.Pong,
]);

export function decodeEnvelope(bytes: Uint8Array, options: DecodeOptions = {}): Envelope {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

  if (bytes.length < HEADER_SIZE) {
    throw new EnvelopeDecodeError(DecodeErrorReason.TooShort, `${bytes.length} < ${HEADER_SIZE}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const version = view.getUint8(0);
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeDecodeError(DecodeErrorReason.UnsupportedVersion, String(version));
  }

  const channel = view.getUint8(1);
  if (!KNOWN_CHANNELS.has(channel)) {
    throw new EnvelopeDecodeError(DecodeErrorReason.BadChannel, String(channel));
  }

  const flags = view.getUint8(2);
  if (flags !== 0) {
    // Bit 0 COMPRESSED reserved and MUST be 0 in v2; all other bits reserved.
    throw new EnvelopeDecodeError(DecodeErrorReason.BadFlags, String(flags));
  }

  const reserved = view.getUint8(3);
  if (reserved !== 0) {
    throw new EnvelopeDecodeError(DecodeErrorReason.BadReserved, String(reserved));
  }

  const systemType = view.getUint16(4, true);
  if (channel === Channel.System) {
    if (!KNOWN_SYSTEM_TYPES.has(systemType)) {
      throw new EnvelopeDecodeError(DecodeErrorReason.BadSystemType, String(systemType));
    }
  } else if (systemType !== 0) {
    // systemType MUST be 0 on App/Frame channels (Part I §1.2).
    throw new EnvelopeDecodeError(DecodeErrorReason.BadSystemType, `nonzero on channel ${channel}`);
  }

  const clientId = view.getUint16(6, true);
  const payloadLen = view.getUint32(8, true);

  // Cap check BEFORE any read/allocation of the body (Part I §1.6, ENV-25).
  if (payloadLen > maxPayloadBytes) {
    throw new EnvelopeDecodeError(
      DecodeErrorReason.PayloadTooLarge,
      `${payloadLen} > ${maxPayloadBytes}`,
    );
  }

  // Exact-length check guards against short and long buffers; no over-read.
  if (bytes.length !== HEADER_SIZE + payloadLen) {
    throw new EnvelopeDecodeError(
      DecodeErrorReason.LengthMismatch,
      `header says ${payloadLen}, buffer holds ${bytes.length - HEADER_SIZE}`,
    );
  }

  const payload = bytes.slice(HEADER_SIZE);
  return { channel, systemType: channel === Channel.System ? systemType : 0, clientId, payload };
}

export interface FrameHeader {
  frameSeq: number;
  sourceTick: number;
  body: Uint8Array;
}

/** Split a decoded Frame payload into its framework prefix and opaque body. */
export function readFrameHeader(payload: Uint8Array): FrameHeader | null {
  if (payload.length < FRAME_PREFIX_SIZE) {
    return null;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    frameSeq: view.getUint32(0, true),
    sourceTick: view.getUint32(4, true),
    body: payload.slice(FRAME_PREFIX_SIZE),
  };
}

/**
 * Modular newer-than comparison for Frame `frameSeq` (Part I §1.4). Returns
 * true iff `candidate` is strictly newer than `last` across u32 wrap. Used on
 * both the host forwarding side and the peer acceptance side.
 */
export function frameSeqIsNewer(candidate: number, last: number): boolean {
  // Unsigned modular difference; newer iff it lands in the first half-space:
  // 0 < diff < 2^31. `>>> 0` is required — `& 0xffffffff` would be signed.
  const diff = (candidate - last) >>> 0;
  return diff !== 0 && diff < 0x80000000;
}
