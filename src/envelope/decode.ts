import { MessageKind, type Envelope } from './types';

const HEADER_SIZE = 8;

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.length < HEADER_SIZE) {
    throw new Error('Envelope too short');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  const messageKind = view.getUint8(1) as MessageKind;
  const systemType = view.getUint16(2, true);
  const payloadLen = view.getUint32(4, true);

  if (bytes.length !== HEADER_SIZE + payloadLen) {
    throw new Error('Envelope payload length mismatch');
  }

  const payload = bytes.slice(HEADER_SIZE);
  return {
    version,
    messageKind,
    systemType,
    payload,
  };
}
