// The reference v2 host core (Part I §1–§3, Part II §2/§5/§7). Drives one
// provisioned vignette over BytePeer transports: mints identities, delivers the
// canonical ABI ops strictly serially, drains the targeted outbox after every
// op, publishes frames, and contains errors (peer-fault vs sim-fatal).
//
// This is the unit `runHostConformance` drives. It handles Provision/Join/Leave
// and Ping; reconnect grace and empty/lifetime timers are Phase 4 (docs/TODO).
// The worker and WebSocket adapters (Phase 7) wrap this by supplying BytePeers.

import { Clock } from './Clock.js';
import { FixedStepEngine } from './FixedStepEngine.js';
import { HostLoop } from './HostLoop.js';
import { PeerRegistry } from './PeerRegistry.js';
import type { BytePeer } from '../transports/BytePeer.js';
import {
  PeerLeftReason,
  type FrameView,
  type Vignette,
} from '../vignettes/Vignette.js';
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

/** A single manifest entry in code form (full Manifest resolution is Phase 5). */
export interface HostVignetteEntry {
  vignetteId: string;
  version: string;
  fixedStepUs: number;
  maxSubsteps: number;
  maxPeers: number;
  maxPayloadBytes?: number;
  create(): Vignette | Promise<Vignette>;
}

export interface PeerConnection {
  /** Detach this transport from the host. */
  disconnect(): void;
}

class Conn {
  clientId: number | null = null;
  constructor(readonly pipe: BytePeer) {}
}

class OversizedEmissionError extends Error {
  constructor(len: number, cap: number) {
    super(`vignette emitted ${len} bytes, exceeding the ${cap}-byte cap`);
    this.name = 'OversizedEmissionError';
  }
}

export class VignetteHost {
  private readonly clock: Clock;
  private readonly registry = new PeerRegistry();
  private readonly conns = new Set<Conn>();
  private readonly maxPayloadBytes: number;

  private state: HostState = 'IDLE';
  private vignette: Vignette | null = null;
  private engine: FixedStepEngine | null = null;
  private loop: HostLoop | null = null;

  // Serializes every vignette op so the ABI's strict, non-reentrant discipline
  // (Part I §2.2) holds for free: each queued unit runs to completion in order.
  private opChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly entry: HostVignetteEntry,
    clock: Clock,
  ) {
    this.clock = clock;
    this.maxPayloadBytes = entry.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
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
          // No reconnect grace yet (Phase 4): abrupt drop evicts as TimedOut.
          void this.run(() => this.evict(conn, PeerLeftReason.TimedOut));
        }
      },
    };
  }

  /** Enqueue one host loop iteration. Resolves when it completes. */
  pump(): Promise<void> {
    return this.run(() => this.loop?.pump() ?? Promise.resolve());
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
    if (init.vignetteId !== this.entry.vignetteId) {
      this.sendError(conn.pipe, ErrorCode.UnknownVignette, init.vignetteId);
      return;
    }

    this.state = 'INITING';
    try {
      this.vignette = await this.entry.create();
      this.engine = new FixedStepEngine(this.entry.fixedStepUs, this.entry.maxSubsteps);
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

    this.loop = new HostLoop(this.clock, this.engine, this.vignette, this.loopHooks());
    this.state = 'READY';
    await this.admitPeer(conn);
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
    if (join.vignetteId !== this.entry.vignetteId) {
      this.sendError(conn.pipe, ErrorCode.UnknownVignette, join.vignetteId);
      return;
    }
    if (this.registry.attachedCount >= this.entry.maxPeers) {
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

    const ok = await this.invokeSimOp(() => this.vignette!.peerJoined(id));
    if (!ok) {
      return; // peerJoined threw → sim-fatal already handled
    }

    conn.pipe.send(
      encodeSystemEnvelope(
        SystemType.Ready,
        encodeReadyPayload({
          vignetteId: this.entry.vignetteId,
          version: this.entry.version,
          clientId: id,
          fixedStepUs: this.entry.fixedStepUs,
        }),
        id,
      ),
    );
  }

  private async handleLeave(conn: Conn): Promise<void> {
    if (conn.clientId === null) {
      return;
    }
    await this.evict(conn, PeerLeftReason.Left);
  }

  /** Detach + retire + peerLeft (drained). Shared by Leave and eviction. */
  private async evict(conn: Conn, reason: PeerLeftReason): Promise<void> {
    if (conn.clientId === null || this.state !== 'READY') {
      return;
    }
    const id = conn.clientId;
    conn.clientId = null;
    this.registry.detach(id);
    await this.invokeSimOp(() => this.vignette!.peerLeft(id, reason));
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
      // A throw from handleMessage is attributed to the sender (Part I §2.4).
      this.peerFault(conn, err);
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

  private sendError(pipe: BytePeer, code: ErrorCode, message: string): void {
    pipe.send(
      encodeSystemEnvelope(SystemType.Error, encodeErrorPayload({ code, message })),
    );
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
