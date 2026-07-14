import {
  ENVELOPE_VERSION,
  MessageKind,
  SystemType,
  type AppEnvelope,
  type Envelope,
  type SystemEnvelope,
} from './types.js';

const HEADER_SIZE = 8;

function encodeEnvelope(envelope: Envelope): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + envelope.payload.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  view.setUint8(0, envelope.version >>> 0);
  view.setUint8(1, envelope.messageKind >>> 0);
  view.setUint16(2, envelope.systemType >>> 0, true);
  view.setUint32(4, envelope.payload.length >>> 0, true);

  out.set(envelope.payload, HEADER_SIZE);
  return out;
}

export function encodeSystemEnvelope(
  systemType: SystemType,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const envelope: SystemEnvelope = {
    version: ENVELOPE_VERSION,
    messageKind: MessageKind.System,
    systemType,
    payload,
  };
  return encodeEnvelope(envelope);
}

export function encodeAppEnvelope(payload: Uint8Array): Uint8Array {
  const envelope: AppEnvelope = {
    version: ENVELOPE_VERSION,
    messageKind: MessageKind.App,
    systemType: 0,
    payload,
  };
  return encodeEnvelope(envelope);
}
