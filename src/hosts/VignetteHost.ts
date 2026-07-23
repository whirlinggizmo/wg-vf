// The reference v2 host core (Part I §1–§3, Part II §2/§5/§7). Drives one
// provisioned vignette over BytePeer transports: mints identities, delivers the
// canonical ABI ops strictly serially, drains the targeted outbox after every
// op, publishes frames, contains errors (peer-fault vs sim-fatal), and owns the
// session lifetime (reconnect grace + empty-session teardown).
//
// This is the unit `hostConformanceCases` drives. The worker and WebSocket
// adapters (Phase 7) wrap it by supplying BytePeers. Lifetime timers are
// evaluated on pump() (and on the explicit poll()) against the injected clock,
// so they fire deterministically under VirtualClock with no wall-clock time.

import { Clock } from './Clock.js';
import { FixedStepEngine } from './FixedStepEngine.js';
import { HostLoop } from './HostLoop.js';
import { PeerRegistry } from './PeerRegistry.js';
import {
  isModuleSource,
  singleVignetteManifest,
  type Manifest,
  type ManifestEntry,
} from './Manifest.js';
import { loadVignetteModule } from './loadVignetteModule.js';
import type { BytePeer } from '../transports/BytePeer.js';
import {
  PeerLeftReason,
  SimFatalError,
  type FrameView,
  type Vignette,
  type VignetteServices,
} from '../vignettes/Vignette.js';
import {
  MountedStorage,
  VignetteStorageSession,
  vignetteFs,
  scopeFor,
  type DurableStore,
} from '../storage/VignetteStorage.js';
import {
  Channel,
  DEFAULT_MAX_PAYLOAD_BYTES,
  EnvelopeDecodeError,
  ErrorCode,
  SystemType,
  decodeEnvelope,
  encodeAppEnvelope,
  encodeFrameEnvelope,
  encodeSystemEnvelope,
  errorCodeForDecodeReason,
  type Envelope,
} from '../envelope/index.js';
import {
  decodeInitPayload,
  decodeJoinPayload,
  encodeErrorPayload,
  encodeReadyPayload,
} from '../envelope/systemPayloads.js';

export type HostState = 'IDLE' | 'INITING' | 'READY' | 'SHUTTING_DOWN' | 'CLOSED';

export interface VignetteHostOptions {
  /** Payload cap before a vignette is provisioned. Defaults to 1 MiB. */
  maxPayloadBytes?: number;
  /**
   * Durable backend for vignette storage. When set, the host restores the
   * vignette's mount before `init` and its `flush()` persists here. When unset,
   * storage is still available but ephemeral (lost on teardown).
   */
  durableStore?: DurableStore;
  /**
   * Stable scope for this host's durable storage — a save slot / room / user id
   * that a reloaded instance reuses to find its data. Combined with the
   * vignette id via {@link scopeFor}. Defaults to `'default'`.
   */
  storageKey?: string;
}

export interface PeerConnection {
  /** Detach this transport from the host (transport-drop semantics). */
  disconnect(): void;
}

class Conn {
  clientId: number | null = null;
  constructor(readonly pipe: BytePeer) {}
}

interface PendingReconnect {
  startUs: number;
  token: Uint8Array;
}

class OversizedEmissionError extends Error {
  constructor(len: number, cap: number) {
    super(`vignette emitted ${len} bytes, exceeding the ${cap}-byte cap`);
    this.name = 'OversizedEmissionError';
  }
}

const TOKEN_BYTES = 16;

export class VignetteHost {
  private readonly clock: Clock;
  private readonly registry = new PeerRegistry();
  private readonly conns = new Set<Conn>();
  private readonly defaultMaxPayloadBytes: number;

  // Set at Provision when the named vignette is resolved (Part I §3.1).
  private provisionedId: string | null = null;
  private provisioned: ManifestEntry | null = null;
  private maxPayloadBytes: number;
  private reconnectGraceUs = 0;
  private emptyGraceUs = 0;

  private state: HostState = 'IDLE';
  private vignette: Vignette | null = null;
  private engine: FixedStepEngine | null = null;
  private loop: HostLoop | null = null;

  // Reconnect-pending peers keep their id live (no peerLeft) until grace expiry.
  private readonly pending = new Map<number, PendingReconnect>();
  private readonly tokenById = new Map<number, Uint8Array>();
  private tokenCounter = 0;

  // When the session is empty (no attached peers, no pending), the moment it
  // became empty; null otherwise. Expiry → host-initiated shutdown.
  private emptyStartUs: number | null = null;

  // Serializes every vignette op so the ABI's strict, non-reentrant discipline
  // (Part I §2.2) holds for free: each queued unit runs to completion in order.
  private opChain: Promise<void> = Promise.resolve();

  // Vignette storage: the durable backend (if any) and this session's scope key.
  private readonly durableStore: DurableStore | null;
  private readonly storageKey: string;

  constructor(
    private readonly manifest: Manifest,
    clock: Clock,
    options: VignetteHostOptions = {},
  ) {
    this.clock = clock;
    this.defaultMaxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxPayloadBytes = this.defaultMaxPayloadBytes;
    this.durableStore = options.durableStore ?? null;
    this.storageKey = options.storageKey ?? 'default';
  }

  /** Convenience for a host that serves a single named vignette. */
  static single(
    vignetteId: string,
    entry: ManifestEntry,
    clock: Clock,
    options?: VignetteHostOptions,
  ): VignetteHost {
    return new VignetteHost(singleVignetteManifest(vignetteId, entry), clock, options);
  }

  getState(): HostState {
    return this.state;
  }

  /**
   * Resolves once the current op queue has drained. Since inbound handling is
   * enqueued synchronously when bytes arrive, `await host.whenIdle()` after a
   * peer send observes the fully-processed result. Test/introspection aid.
   */
  whenIdle(): Promise<void> {
    return this.opChain;
  }

  /** Attach a transport. Identity is assigned when it sends Init/Join. */
  connect(pipe: BytePeer): PeerConnection {
    const conn = new Conn(pipe);
    this.conns.add(conn);
    const off = pipe.onBytes((bytes) => {
      void this.run(() => this.onInbound(conn, bytes));
    });
    return {
      disconnect: () => {
        off();
        this.conns.delete(conn);
        if (conn.clientId !== null) {
          void this.run(() => this.handleTransportDrop(conn));
        }
      },
    };
  }

  /** Enqueue one host loop iteration, after evaluating lifetime timers. */
  pump(): Promise<void> {
    return this.run(async () => {
      await this.processTimers(this.clock.nowUs());
      if (this.state === 'READY') {
        await this.loop?.pump();
      }
    });
  }

  /** Evaluate lifetime timers without stepping the sim (e.g. an idle session). */
  poll(): Promise<void> {
    return this.run(() => this.processTimers(this.clock.nowUs()));
  }

  // --- op serialization ----------------------------------------------------

  private run(fn: () => void | Promise<void>): Promise<void> {
    const next = this.opChain.then(() => fn());
    // Keep the chain alive even if an op rejects; ops contain their own errors,
    // so a rejection here is unexpected and must not wedge the queue.
    this.opChain = next.catch(() => {});
    return next;
  }

  // --- inbound dispatch ----------------------------------------------------

  private async onInbound(conn: Conn, bytes: Uint8Array): Promise<void> {
    let env: Envelope;
    try {
      env = decodeEnvelope(bytes, { maxPayloadBytes: this.maxPayloadBytes });
    } catch (err) {
      if (err instanceof EnvelopeDecodeError) {
        this.sendError(conn.pipe, errorCodeForDecodeReason(err.reason), err.message);
        return;
      }
      throw err;
    }

    switch (env.channel) {
      case Channel.System:
        await this.handleSystem(conn, env);
        return;
      case Channel.App:
        await this.deliverApp(conn, env.payload);
        return;
      case Channel.Frame:
        // Client-published frames are out of scope this phase.
        return;
    }
  }

  private async handleSystem(conn: Conn, env: Envelope): Promise<void> {
    switch (env.systemType) {
      case SystemType.Init:
        await this.handleInit(conn, env.payload);
        return;
      case SystemType.Join:
        await this.handleJoin(conn, env.payload);
        return;
      case SystemType.Leave:
      case SystemType.Shutdown:
        // Peer-originated Shutdown is a leave request only (Part I §3.6).
        await this.handleLeave(conn);
        return;
      case SystemType.Ping:
        conn.pipe.send(encodeSystemEnvelope(SystemType.Pong, env.payload));
        return;
      default:
        // Ready/Error/Pong are host→peer; ignore if a peer sends them.
        return;
    }
  }

  // --- session verbs -------------------------------------------------------

  private async handleInit(conn: Conn, payload: Uint8Array): Promise<void> {
    if (this.state !== 'IDLE') {
      this.sendError(conn.pipe, ErrorCode.Generic, 'already provisioned');
      return;
    }
    const init = decodeInitPayload(payload);
    if (init === null) {
      this.sendError(conn.pipe, ErrorCode.Generic, 'malformed Init payload');
      return;
    }
    // Resolve the named id against the manifest (Part I §3.1) — the host, not
    // the peer, decides what code runs.
    const entry = this.manifest.vignettes[init.vignetteId];
    if (!entry) {
      this.sendError(conn.pipe, ErrorCode.UnknownVignette, init.vignetteId);
      return;
    }

    this.state = 'INITING';
    try {
      this.vignette = isModuleSource(entry) ? await loadVignetteModule(entry) : await entry.create();
      this.engine = new FixedStepEngine(entry.fixedStepUs, entry.maxSubsteps);
      // Provide storage and restore any durable state *before* init, so the
      // vignette can rehydrate from its mount as init runs (Part I §3.3).
      await this.attachStorage(this.vignette, init.vignetteId);
      await this.vignette.init(init.initPayload);
    } catch (err) {
      // init failure: report to the provisioning peer, stay un-provisioned so a
      // later Join sees NotProvisioned and a fresh Init may retry (ABI-17).
      this.vignette = null;
      this.engine = null;
      this.state = 'IDLE';
      this.sendError(conn.pipe, ErrorCode.Generic, errMessage(err));
      return;
    }

    // Lock the session to the resolved vignette and its policy.
    this.provisionedId = init.vignetteId;
    this.provisioned = entry;
    this.maxPayloadBytes = entry.maxPayloadBytes ?? this.defaultMaxPayloadBytes;
    this.reconnectGraceUs = (entry.reconnectGraceMs ?? 0) * 1000;
    this.emptyGraceUs = (entry.emptyGraceMs ?? 0) * 1000;

    this.loop = new HostLoop(this.clock, this.engine, this.vignette, this.loopHooks());
    this.state = 'READY';
    await this.admitPeer(conn);
  }

  /**
   * Build this session's storage mount, restore any durable state, and hand the
   * services to the vignette (before `init`). Storage is always available; it's
   * durable only when the host was given a `durableStore`.
   */
  private async attachStorage(vignette: Vignette, vignetteId: string): Promise<void> {
    const mount = new MountedStorage();
    let flush = (): Promise<void> => Promise.resolve();
    if (this.durableStore) {
      const session = new VignetteStorageSession(scopeFor(vignetteId, this.storageKey), this.durableStore, mount);
      await session.restore();
      flush = () => session.flush();
    }
    const services: VignetteServices = { fs: vignetteFs(mount, flush) };
    vignette.attachServices?.(services);
  }

  private async handleJoin(conn: Conn, payload: Uint8Array): Promise<void> {
    if (this.state !== 'READY') {
      this.sendError(conn.pipe, ErrorCode.NotProvisioned, 'no provisioned session');
      return;
    }
    const join = decodeJoinPayload(payload);
    if (join === null) {
      this.sendError(conn.pipe, ErrorCode.Generic, 'malformed Join payload');
      return;
    }
    if (join.vignetteId !== this.provisionedId) {
      this.sendError(conn.pipe, ErrorCode.UnknownVignette, join.vignetteId);
      return;
    }

    // A valid resumeToken rebinds the same id without a peerLeft/peerJoined
    // cycle. A stale/forged token falls through to an ordinary Join (Part I §3.3).
    if (join.resumeToken && this.tryReconnect(conn, join.resumeToken)) {
      return;
    }

    if (this.registry.attachedCount >= this.provisioned!.maxPeers) {
      this.sendError(conn.pipe, ErrorCode.SessionFull, 'session full');
      return;
    }
    await this.admitPeer(conn);
  }

  /** Mint id, attach, peerJoined (drained), then unicast Ready (Part I §3.3). */
  private async admitPeer(conn: Conn): Promise<void> {
    const id = this.registry.mint();
    conn.clientId = id;
    this.registry.attach(id, conn.pipe);
    const token = this.newToken();
    this.tokenById.set(id, token);
    void this.updateEmptyTimer(); // a fresh attach can't empty the session

    const ok = await this.invokeSimOp(() => this.vignette!.peerJoined(id));
    if (!ok) {
      return; // peerJoined threw → sim-fatal already handled
    }

    this.sendReady(conn.pipe, id, token);
  }

  /** Rebind a reconnecting transport to its live id, if the token matches. */
  private tryReconnect(conn: Conn, token: Uint8Array): boolean {
    for (const [id, rec] of this.pending) {
      if (rec.token.length > 0 && bytesEqual(rec.token, token)) {
        this.pending.delete(id);
        conn.clientId = id;
        const fresh = this.newToken();
        this.tokenById.set(id, fresh);
        this.registry.attach(id, conn.pipe);
        void this.updateEmptyTimer(); // a reconnect re-attaches, can't empty the session
        // Same id, no peerJoined — the sim never saw the peer leave.
        this.sendReady(conn.pipe, id, fresh);
        return true;
      }
    }
    return false;
  }

  private async handleLeave(conn: Conn): Promise<void> {
    if (conn.clientId === null) {
      return;
    }
    await this.evict(conn, PeerLeftReason.Left);
  }

  /** Transport dropped: enter reconnect grace, or evict if grace is disabled. */
  private async handleTransportDrop(conn: Conn): Promise<void> {
    if (conn.clientId === null || this.state !== 'READY') {
      return;
    }
    const id = conn.clientId;
    conn.clientId = null;

    if (this.reconnectGraceUs === 0) {
      await this.retirePeer(id, PeerLeftReason.TimedOut);
      return;
    }
    // Keep the id live (no peerLeft); detach routing so gap traffic is dropped.
    this.registry.detach(id);
    this.pending.set(id, {
      startUs: this.clock.nowUs(),
      token: this.tokenById.get(id) ?? new Uint8Array(0),
    });
    await this.updateEmptyTimer(); // dropping to empty may trigger graceful teardown
  }

  private async evict(conn: Conn, reason: PeerLeftReason): Promise<void> {
    if (conn.clientId === null || this.state !== 'READY') {
      return;
    }
    const id = conn.clientId;
    conn.clientId = null;
    await this.retirePeer(id, reason);
  }

  /** Detach + retire an id and deliver peerLeft (drained). */
  private async retirePeer(id: number, reason: PeerLeftReason): Promise<void> {
    this.registry.detach(id);
    this.tokenById.delete(id);
    this.pending.delete(id);
    await this.invokeSimOp(() => this.vignette!.peerLeft(id, reason));
    await this.updateEmptyTimer(); // last peer out may trigger graceful teardown
  }

  // --- lifetime timers -----------------------------------------------------

  private async processTimers(now: number): Promise<void> {
    if (this.state !== 'READY') {
      return;
    }
    // Reconnect grace expiries → peerLeft(TimedOut).
    for (const [id, rec] of [...this.pending]) {
      if (((now - rec.startUs) >>> 0) >= this.reconnectGraceUs) {
        this.pending.delete(id);
        await this.retirePeer(id, PeerLeftReason.TimedOut);
      }
    }
    // Empty-session grace expiry → host-initiated shutdown.
    if (
      this.state === 'READY' &&
      this.emptyStartUs !== null &&
      ((now - this.emptyStartUs) >>> 0) >= this.emptyGraceUs
    ) {
      await this.hostShutdown();
    }
  }

  private async updateEmptyTimer(): Promise<void> {
    if (this.state !== 'READY') {
      this.emptyStartUs = null;
      return;
    }
    const empty = this.registry.attachedCount === 0 && this.pending.size === 0;
    if (!empty) {
      this.emptyStartUs = null;
      return;
    }
    if (this.emptyGraceUs === 0) {
      await this.hostShutdown();
      return;
    }
    if (this.emptyStartUs === null) {
      this.emptyStartUs = this.clock.nowUs();
    }
  }

  /** Host-initiated teardown: broadcast Shutdown, then run vignette shutdown (§3.5). */
  private async hostShutdown(): Promise<void> {
    if (this.state !== 'READY') {
      return;
    }
    this.state = 'SHUTTING_DOWN';
    this.loop?.stop();
    this.emptyStartUs = null;
    this.registry.route(0, encodeSystemEnvelope(SystemType.Shutdown));
    // A graceful teardown gives the vignette a real chance to persist: await
    // shutdown() (which may await a flush) inline, so a single whenIdle() waits
    // for the durable write. (Contrast simFatal, which stays fire-and-forget — a
    // faulted sim's state is untrustworthy, so we don't wait on its flush.)
    try {
      await this.vignette?.shutdown();
    } catch {
      /* graceful teardown: swallow */
    }
    this.state = 'CLOSED';
  }

  // --- App delivery & containment -----------------------------------------

  private async deliverApp(conn: Conn, payload: Uint8Array): Promise<void> {
    if (this.state !== 'READY' || conn.clientId === null) {
      return;
    }
    const sender = conn.clientId;
    try {
      await this.vignette!.handleMessage(sender, payload);
    } catch (err) {
      // A binding may force sim-fatal (a WASM trap is untrustworthy, ABI-18);
      // otherwise a handleMessage throw is attributed to the sender (ABI-15).
      if (err instanceof SimFatalError) {
        this.simFatal(err);
      } else {
        this.peerFault(conn, err);
      }
      return;
    }
    try {
      this.drainOutbox();
    } catch (err) {
      this.simFatal(err); // e.g. oversized emission is a sim fault (§1.6/§2.4)
    }
  }

  private peerFault(conn: Conn, err: unknown): void {
    if (conn.clientId === null) {
      return;
    }
    this.sendError(conn.pipe, ErrorCode.PeerFault, errMessage(err));
    void this.evict(conn, PeerLeftReason.Fault);
  }

  /** Run a host-driven vignette op; drain on success, sim-fatal on throw. */
  private async invokeSimOp(fn: () => void | Promise<void>): Promise<boolean> {
    try {
      await fn();
      this.drainOutbox();
      return true;
    } catch (err) {
      this.simFatal(err);
      return false;
    }
  }

  private simFatal(err: unknown): void {
    if (this.state === 'SHUTTING_DOWN' || this.state === 'CLOSED') {
      return;
    }
    this.state = 'SHUTTING_DOWN';
    this.loop?.stop();
    this.registry.route(
      0,
      encodeSystemEnvelope(
        SystemType.Error,
        encodeErrorPayload({ code: ErrorCode.Generic, message: errMessage(err) }),
      ),
    );
    try {
      // Fire shutdown; a throw here cannot make things more fatal.
      void this.vignette?.shutdown();
    } catch {
      /* ignore */
    }
    this.state = 'CLOSED';
  }

  // --- outbox / frame hooks ------------------------------------------------

  private loopHooks() {
    return {
      drainOutbox: () => this.drainOutbox(),
      publishFrame: (frame: FrameView, sourceTick: number) =>
        this.publishFrame(frame, sourceTick),
      onSimFatal: (err: unknown) => this.simFatal(err),
    };
  }

  private drainOutbox(): void {
    const vignette = this.vignette;
    if (!vignette) {
      return;
    }
    while (vignette.outboxHasMessages()) {
      const { targetId, payload } = vignette.outboxPop();
      if (payload.length > this.maxPayloadBytes) {
        throw new OversizedEmissionError(payload.length, this.maxPayloadBytes);
      }
      this.registry.route(targetId, encodeAppEnvelope(payload, targetId));
    }
  }

  private publishFrame(frame: FrameView, sourceTick: number): void {
    this.registry.route(0, encodeFrameEnvelope(frame.body, frame.seq, sourceTick, 0));
  }

  private sendReady(pipe: BytePeer, clientId: number, resumeToken: Uint8Array): void {
    pipe.send(
      encodeSystemEnvelope(
        SystemType.Ready,
        encodeReadyPayload({
          vignetteId: this.provisionedId!,
          version: this.provisioned!.version,
          clientId,
          fixedStepUs: this.provisioned!.fixedStepUs,
          resumeToken,
        }),
        clientId,
      ),
    );
  }

  private sendError(pipe: BytePeer, code: ErrorCode, message: string): void {
    pipe.send(
      encodeSystemEnvelope(SystemType.Error, encodeErrorPayload({ code, message })),
    );
  }

  private newToken(): Uint8Array {
    const token = new Uint8Array(TOKEN_BYTES);
    const g = globalThis.crypto;
    if (g && typeof g.getRandomValues === 'function') {
      g.getRandomValues(token);
      return token;
    }
    // Non-crypto fallback (environments without WebCrypto); unique per session.
    for (let i = 0; i < TOKEN_BYTES; i++) {
      token[i] = (this.tokenCounter + i * 31) & 0xff;
    }
    this.tokenCounter = (this.tokenCounter + 1) >>> 0;
    return token;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
