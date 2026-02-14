export type { Vignette } from './Vignette';
export type { VignetteHost } from './VignetteHost';
export type { VignetteClient } from './VignetteClient';
export type { VignetteType, WorkerVignetteType, RemoteVignetteType } from './VignetteTypes';
export { isWorkerVignetteType, isRemoteVignetteType } from './VignetteTypes';

export { VignetteClientImpl } from './VignetteClient';

export type { Transport } from './transports/Transport';
export { WorkerTransport } from './transports/WorkerTransport';
export { WebSocketTransport } from './transports/WebSocketTransport';
export {
  ReconnectingWebSocketTransport,
  type ReconnectingWebSocketTransportOptions,
} from './transports/ReconnectingWebSocketTransport';

export { WorkerVignetteHost } from './hosts/WorkerVignetteHost';
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
} from './envelope/systemPayloads';
