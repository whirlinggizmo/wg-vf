// Envelope v2 encoders (Part I §1.2). Encoders are the golden-byte source of
// truth; they validate structural invariants but do not enforce the payload
// cap (that is a host ingress policy, applied on decode — Part I §1.6).

import {
  Channel,
  ENVELOPE_VERSION,
  FRAME_PREFIX_SIZE,
  HEADER_SIZE,
  SystemType,
} from './types.js';

export interface EncodeEnvelopeInput {
  channel: Channel;
  /** Required (and only meaningful) when `channel === System`. */
  systemType?: number;
  /** Sender on host-bound, target on peer-bound. Defaults to 0 (none/broadcast). */
  clientId?: number;
  payload?: Uint8Array;
}

function u16(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be a u16, got ${value}`);
  }
  return value;
}

/** Encode any v2 envelope. Header is 12 bytes, little-endian throughout. */
export function encodeEnvelope(input: EncodeEnvelopeInput): Uint8Array {
  const payload = input.payload ?? new Uint8Array(0);
  const systemType =
    input.channel === Channel.System ? u16('systemType', input.systemType ?? 0) : 0;
  const clientId = u16('clientId', input.clientId ?? 0);

  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  view.setUint8(0, ENVELOPE_VERSION);
  view.setUint8(1, input.channel);
  view.setUint8(2, 0); // flags — bit 0 COMPRESSED reserved, MUST be 0 in v2
  view.setUint8(3, 0); // reserved — MUST be 0
  view.setUint16(4, systemType, true);
  view.setUint16(6, clientId, true);
  view.setUint32(8, payload.length >>> 0, true);
  out.set(payload, HEADER_SIZE);

  return out;
}

export function encodeSystemEnvelope(
  systemType: SystemType,
  payload: Uint8Array = new Uint8Array(0),
  clientId = 0,
): Uint8Array {
  return encodeEnvelope({ channel: Channel.System, systemType, clientId, payload });
}

export function encodeAppEnvelope(payload: Uint8Array, clientId = 0): Uint8Array {
  return encodeEnvelope({ channel: Channel.App, clientId, payload });
}

/**
 * Build the Frame *payload* — the framework-owned `frameSeq: u32,
 * sourceTick: u32` prefix (Part I §1.4) followed by the opaque body. This is the
 * envelope payload; wrap it as `{ channel: Frame, payload }` to frame it.
 */
export function encodeFramePayload(body: Uint8Array, frameSeq: number, sourceTick: number): Uint8Array {
  const payload = new Uint8Array(FRAME_PREFIX_SIZE + body.length);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint32(0, frameSeq >>> 0, true);
  view.setUint32(4, sourceTick >>> 0, true);
  payload.set(body, FRAME_PREFIX_SIZE);
  return payload;
}

/**
 * Encode a Frame envelope, prepending the framework-owned
 * `frameSeq: u32, sourceTick: u32` prefix (Part I §1.4) to the opaque body.
 */
export function encodeFrameEnvelope(
  body: Uint8Array,
  frameSeq: number,
  sourceTick: number,
  clientId = 0,
): Uint8Array {
  return encodeEnvelope({ channel: Channel.Frame, clientId, payload: encodeFramePayload(body, frameSeq, sourceTick) });
}
