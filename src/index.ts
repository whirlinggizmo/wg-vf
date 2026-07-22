// @whirlinggizmo/wg-vf — public API.

// Wire envelope (docs/architecture-part1.md §1).
export * from './envelope/index.js';

// Vignette ABI (docs/architecture-part1.md §2).
export type { Vignette, OutboxEntry, FrameView } from './vignettes/Vignette.js';
export { PeerLeftReason } from './vignettes/Vignette.js';
export { BaseVignette } from './vignettes/BaseVignette.js';

// Host core (docs/architecture-part1.md §2/§3, Part II).
export {
  VignetteHost,
  type HostVignetteEntry,
  type PeerConnection,
  type HostState,
} from './hosts/VignetteHost.js';
export { SessionManager, type SessionManagerOptions } from './hosts/SessionManager.js';
export { FixedStepEngine } from './hosts/FixedStepEngine.js';
export { HostLoop, type HostLoopVignette, type HostLoopHooks } from './hosts/HostLoop.js';
export { PeerRegistry, PeerIdExhaustedError } from './hosts/PeerRegistry.js';
export { type Clock, SystemClock } from './hosts/Clock.js';

// Transports (byte pipes; Part II §8).
export type { Transport } from './transports/Transport.js';
export type { BytePeer } from './transports/BytePeer.js';
export { WebSocketTransport } from './transports/WebSocketTransport.js';
export {
  ReconnectingWebSocketTransport,
  type ReconnectingWebSocketTransportOptions,
} from './transports/ReconnectingWebSocketTransport.js';
