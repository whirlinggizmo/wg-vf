export { isVignetteType } from './Vignette';
export type { Vignette, VignetteType } from './Vignette';
export type { VignetteHost } from './VignetteHost';
export {
  VignetteBridge,
  type LocalVignetteBridgeConfig,
  type RemoteVignetteBridgeConfig,
  type VignetteBridgeConfig,
  type VignetteBridgePingResult,
} from './VignetteBridge';

export { WebSocketTransport } from './transports/WebSocketTransport';
export {
  ReconnectingWebSocketTransport,
  type ReconnectingWebSocketTransportOptions,
} from './transports/ReconnectingWebSocketTransport';

export { LocalVignetteHost } from './hosts/LocalVignetteHost';
export { RemoteVignetteHost } from './hosts/RemoteVignetteHost';

export type { WasmVignetteInstance, WasmVignetteOptions } from './WasmVignette';
export { createWasmInstance } from './WasmVignette';

export {
  ENVELOPE_VERSION,
  MessageKind,
  SystemType,
  type Envelope,
  type AppEnvelope,
  type SystemEnvelope,
} from './envelope/types';

export { decodeEnvelope } from './envelope/decode';
export { encodeAppEnvelope, encodeSystemEnvelope } from './envelope/encode';
export {
  type ReadyPayload,
  type ErrorPayload,
  encodeReadyPayload,
  decodeReadyPayload,
  encodeErrorPayload,
  decodeErrorPayload,
  type PingPayload,
  encodePingPayload,
  decodePingPayload,
} from './envelope/systemPayloads';
