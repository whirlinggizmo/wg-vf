export { isVignetteType } from './vignettes/Vignette';
export type { Vignette, VignetteType } from './vignettes/Vignette';
export { BaseVignette } from './vignettes/BaseVignette';
export type { VignetteHost } from './hosts/VignetteHost';
export {
  VignetteBridge,
  type LocalVignetteBridgeConfig,
  type RemoteVignetteBridgeConfig,
  type VignetteBridgeConfig,
  type VignetteBridgePingResult,
} from './bridge/VignetteBridge';

export { WebSocketTransport } from './transports/WebSocketTransport';
export {
  ReconnectingWebSocketTransport,
  type ReconnectingWebSocketTransportOptions,
} from './transports/ReconnectingWebSocketTransport';

export { LocalVignetteHost } from './hosts/LocalVignetteHost';
export { RemoteVignetteHost } from './hosts/RemoteVignetteHost';

export type { WasmVignetteInstance, WasmVignetteOptions } from './vignettes/WasmVignette';
export { createWasmInstance } from './vignettes/WasmVignette';

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
  type InitPayload,
  encodeReadyPayload,
  decodeReadyPayload,
  encodeErrorPayload,
  decodeErrorPayload,
  type PingPayload,
  encodePingPayload,
  decodePingPayload,
  encodeInitPayload,
  decodeInitPayload,
} from './envelope/systemPayloads';
