export { isVignetteType } from './vignettes/Vignette.js';
export type { Vignette, VignetteType } from './vignettes/Vignette.js';
export { BaseVignette } from './vignettes/BaseVignette.js';
export type { VignetteHost } from './hosts/VignetteHost.js';
export {
  VignetteBridge,
  type LocalVignetteBridgeConfig,
  type RemoteVignetteBridgeConfig,
  type VignetteBridgeConfig,
  type VignetteBridgePingResult,
} from './bridge/VignetteBridge.js';

export { WebSocketTransport } from './transports/WebSocketTransport.js';
export {
  ReconnectingWebSocketTransport,
  type ReconnectingWebSocketTransportOptions,
} from './transports/ReconnectingWebSocketTransport.js';

export { LocalVignetteHost } from './hosts/LocalVignetteHost.js';
export { RemoteVignetteHost } from './hosts/RemoteVignetteHost.js';

export type { WasmVignetteInstance, WasmVignetteOptions } from './vignettes/WasmVignette.js';
export { createWasmInstance } from './vignettes/WasmVignette.js';

export {
  ENVELOPE_VERSION,
  MessageKind,
  SystemType,
  type Envelope,
  type AppEnvelope,
  type SystemEnvelope,
} from './envelope/types.js';

export { decodeEnvelope } from './envelope/decode.js';
export { encodeAppEnvelope, encodeSystemEnvelope } from './envelope/encode.js';
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
} from './envelope/systemPayloads.js';
