// Maps a session key (room id) to a VignetteHost, so one process serves many
// independent sessions and a torn-down session frees its key for a fresh
// Provision (Part I §3.5, Part II §8). Host lifetime is decoupled from any
// socket: the manager creates a host on first connect to a key and reaps it
// once it reaches CLOSED.
//
// Reference server scaffolding — non-normative, but reusable and driven by the
// same BytePeer seam the conformance tooling uses, so it is testable in-process
// with loopback pipes (no real sockets required).

import { type Clock, SystemClock } from './Clock.js';
import { VignetteHost, type PeerConnection } from './VignetteHost.js';
import type { Manifest } from './Manifest.js';
import type { BytePeer } from '../transports/BytePeer.js';
import type { DurableStore } from '../storage/VignetteStorage.js';

export interface SessionManagerOptions {
  /** Resolve a session key to the manifest its host uses, or null to reject the key. */
  manifestFor(key: string): Manifest | null;
  /** Shared clock for every host. Defaults to SystemClock. */
  clock?: Clock;
  /**
   * Durable backend for vignette storage, shared by every host. Each session's
   * scope is keyed by its room, so a peer returning to the same room restores
   * that room's state.
   */
  durableStore?: DurableStore;
  /**
   * Cap on concurrent live sessions. A connect to a *new* key beyond this is
   * refused (a connect to an existing session is always admitted, subject to the
   * host's own `maxPeers`). Unlimited when unset. Bounds host creation so an
   * untrusted client cannot spin up rooms without limit.
   */
  maxSessions?: number;
}

export class SessionManager {
  private readonly clock: Clock;
  private readonly maxSessions?: number;
  private readonly hosts = new Map<string, VignetteHost>();

  constructor(private readonly options: SessionManagerOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.maxSessions = options.maxSessions;
  }

  /**
   * Attach a peer to session `key`, creating the host on first use. Returns null
   * — and the caller should refuse the connection — if the key is unknown or the
   * server is at `maxSessions` capacity for a new key.
   */
  connect(key: string, pipe: BytePeer): PeerConnection | null {
    // Drop any CLOSED hosts first, so a re-provision of a stale key works and the
    // capacity count reflects only live sessions.
    this.reap();
    let host = this.hosts.get(key);
    if (!host) {
      const manifest = this.options.manifestFor(key);
      if (!manifest) {
        return null;
      }
      if (this.maxSessions !== undefined && this.hosts.size >= this.maxSessions) {
        return null; // at capacity — refuse a new session
      }
      host = new VignetteHost(manifest, this.clock, {
        durableStore: this.options.durableStore,
        storageKey: key, // the room is the stable storage scope
      });
      this.hosts.set(key, host);
    }
    return host.connect(pipe);
  }

  /** The live host for a key, if any (for tests/introspection). */
  get(key: string): VignetteHost | undefined {
    return this.hosts.get(key);
  }

  get sessionCount(): number {
    return this.hosts.size;
  }

  sessionKeys(): string[] {
    return [...this.hosts.keys()];
  }

  /** Pump every live host one iteration, then reap any that reached CLOSED. */
  async pumpAll(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.pump()));
    this.reap();
  }

  /** Evaluate lifetime timers on every host, then reap CLOSED ones. */
  async pollAll(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.poll()));
    this.reap();
  }

  /** Resolve once every live host's op queue has drained. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.whenIdle()));
    this.reap();
  }

  private reap(): void {
    for (const [key, host] of this.hosts) {
      if (host.getState() === 'CLOSED') {
        this.hosts.delete(key);
      }
    }
  }
}
