// Envelope v2 public surface (docs/architecture-part1.md §1).
export {
  Channel,
  SystemType,
  ErrorCode,
  DecodeErrorReason,
  EnvelopeDecodeError,
  errorCodeForDecodeReason,
  ENVELOPE_VERSION,
  HEADER_SIZE,
  DEFAULT_MAX_PAYLOAD_BYTES,
  FRAME_PREFIX_SIZE,
  CLIENT_ID_NONE,
  CLIENT_ID_RESERVED,
  type Envelope,
} from './types.js';

export {
  encodeEnvelope,
  encodeSystemEnvelope,
  encodeAppEnvelope,
  encodeFrameEnvelope,
  type EncodeEnvelopeInput,
} from './encode.js';

export {
  decodeEnvelope,
  readFrameHeader,
  frameSeqIsNewer,
  type DecodeOptions,
  type FrameHeader,
} from './decode.js';

export {
  encodeInitPayload,
  decodeInitPayload,
  encodeJoinPayload,
  decodeJoinPayload,
  encodeReadyPayload,
  decodeReadyPayload,
  encodeErrorPayload,
  decodeErrorPayload,
  encodePingPayload,
  decodePingPayload,
  type InitPayload,
  type JoinPayload,
  type ReadyPayload,
  type ErrorPayload,
  type PingPayload,
} from './systemPayloads.js';
