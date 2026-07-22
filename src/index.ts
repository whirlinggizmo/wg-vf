// @whirlinggizmo/wg-vf — public API.

// Wire envelope (docs/architecture-part1.md §1).
export * from './envelope/index.js';

// Vignette ABI (docs/architecture-part1.md §2).
export type { Vignette, OutboxEntry, FrameView } from './vignettes/Vignette.js';
export { PeerLeftReason } from './vignettes/Vignette.js';
export { BaseVignette } from './vignettes/BaseVignette.js';
export {
  createWasmInstance,
  type WasmVignetteInstance,
} from './vignettes/WasmVignette.js';

// Host core (docs/architecture-part1.md §2/§3, Part II).
export {
  VignetteHost,
  type VignetteHostOptions,
  type PeerConnection,
  type HostState,
} from './hosts/VignetteHost.js';
export {
  singleVignetteManifest,
  isModuleSource,
  type Manifest,
  type ManifestEntry,
  type VignetteConfig,
  type VignetteSource,
  type FactorySource,
  type ModuleSource,
} from './hosts/Manifest.js';
export { loadVignetteModule } from './hosts/loadVignetteModule.js';
export { SessionManager, type SessionManagerOptions } from './hosts/SessionManager.js';
export {
  runWorkerHost,
  type WorkerHostOptions,
  type WorkerHostHandle,
} from './hosts/workerHost.js';
export { FixedStepEngine } from './hosts/FixedStepEngine.js';
export { HostLoop, type HostLoopVignette, type HostLoopHooks } from './hosts/HostLoop.js';
export { PeerRegistry, PeerIdExhaustedError } from './hosts/PeerRegistry.js';
export { type Clock, SystemClock } from './hosts/Clock.js';

// Transports (byte pipes; Part II §8).
export type { Transport } from './transports/Transport.js';
export type { BytePeer } from './transports/BytePeer.js';
export {
  messagePortBytePeer,
  type MessagePortLike,
} from './transports/MessagePortBytePeer.js';
export { WebSocketTransport } from './transports/WebSocketTransport.js';
export {
  ReconnectingWebSocketTransport,
  type ReconnectingWebSocketTransportOptions,
} from './transports/ReconnectingWebSocketTransport.js';
