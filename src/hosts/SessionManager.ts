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
import { VignetteHost, type HostVignetteEntry, type PeerConnection } from './VignetteHost.js';
import type { BytePeer } from '../transports/BytePeer.js';

export interface SessionManagerOptions {
  /** Resolve a session key to its manifest entry, or null to reject the key. */
  entryFor(key: string): HostVignetteEntry | null;
  /** Shared clock for every host. Defaults to SystemClock. */
  clock?: Clock;
}

export class SessionManager {
  private readonly clock: Clock;
  private readonly hosts = new Map<string, VignetteHost>();

  constructor(private readonly options: SessionManagerOptions) {
    this.clock = options.clock ?? new SystemClock();
  }

  /**
   * Attach a peer to session `key`, creating the host on first use (or
   * replacing a CLOSED one so the key can be re-provisioned). Returns null if
   * the key is unknown — the caller should refuse the connection.
   */
  connect(key: string, pipe: BytePeer): PeerConnection | null {
    let host = this.hosts.get(key);
    if (host && host.getState() === 'CLOSED') {
      this.hosts.delete(key);
      host = undefined;
    }
    if (!host) {
      const entry = this.options.entryFor(key);
      if (!entry) {
        return null;
      }
      host = new VignetteHost(entry, this.clock);
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
