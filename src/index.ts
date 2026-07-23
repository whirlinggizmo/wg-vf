// @whirlinggizmo/wg-vf — public API.

// Wire envelope (docs/architecture-part1.md §1).
export * from './envelope/index.js';

// Vignette ABI (docs/architecture-part1.md §2).
export type { Vignette, OutboxEntry, FrameView, VignetteServices } from './vignettes/Vignette.js';
export { PeerLeftReason } from './vignettes/Vignette.js';
export { BaseVignette } from './vignettes/BaseVignette.js';
export {
  createWasmInstance,
  WG_VF_ABI_VERSION,
  type WasmVignetteInstance,
} from './vignettes/WasmVignette.js';

// Version surfaces (see the author guide's versioning section):
//   VERSION          — framework package version (semver)
//   WG_VF_ABI_VERSION — host↔sim ABI version (wasm/native + module-form JS; above)
//   ENVELOPE_VERSION  — host↔app wire version (from ./envelope, below)
export { VERSION } from './version.js';

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

// Client-side session resume (Part I §3.3): persist the resumeToken and reopen
// with a resume-Join so a clientId survives a transport drop or a page reload.
// Complements ReconnectingWebSocketTransport (which keeps the socket alive):
// this keeps the *session* alive. See the author guide's resume section.
export {
  ResumeCoordinator,
  memoryTokenStore,
  webStorageTokenStore,
  type TokenStore,
  type SessionRecord,
  type WebStorageLike,
} from './client/SessionResume.js';

// Host-owned vignette storage: a jailed in-memory mount (sync read/write/delete/
// list) with async, host-driven restore/flush to a pluggable durable backend.
// Lets a vignette persist state across a reload without touching real IO itself.
export {
  MountedStorage,
  VignetteStorageSession,
  vignetteFs,
  StorageJailError,
  jailPath,
  scopeFor,
  memoryDurableStore,
  type VignetteFs,
  type DurableStore,
} from './storage/VignetteStorage.js';
export {
  indexedDbDurableStore,
  type IndexedDbDurableStoreOptions,
} from './storage/indexedDbDurableStore.js';
