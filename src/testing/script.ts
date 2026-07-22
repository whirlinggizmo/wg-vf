// T-SCRIPT (test plan §0): an ordered input script and a deterministic runner.
// Drives a VignetteHost over loopback pipes with a VirtualClock and captures the
// observable trace (App + Frame envelopes per peer) — the basis for the
// cross-host / cross-binding determinism suite (§4). System Ready carries a
// random resumeToken, so it is deliberately excluded from the trace.

import { VignetteHost, type PeerConnection } from '../hosts/VignetteHost.js';
import type { ManifestEntry } from '../hosts/Manifest.js';
import type { Vignette } from '../vignettes/Vignette.js';
import type { BytePeer } from '../transports/BytePeer.js';
import { VirtualClock } from './VirtualClock.js';
import { createLoopbackPipe } from './LoopbackBytePipe.js';
import { HostPeer } from './HostPeer.js';
import { Channel } from '../envelope/index.js';

export type ScriptAction =
  | { op: 'connect'; peer: string }
  | { op: 'init'; peer: string; vignetteId?: string; payload?: Uint8Array }
  | { op: 'join'; peer: string; vignetteId?: string }
  | { op: 'app'; peer: string; bytes: Uint8Array }
  | { op: 'leave'; peer: string }
  | { op: 'drop'; peer: string }
  | { op: 'advance'; us: number }
  | { op: 'pump' }
  | { op: 'poll' };

export interface ScriptResult {
  /** App + Frame envelopes each peer received, serialized in arrival order. */
  traces: Record<string, string[]>;
  finalState: string;
}

export interface RunScriptOptions {
  vignetteId?: string;
  fixedStepUs?: number;
  maxSubsteps?: number;
  maxPeers?: number;
  reconnectGraceMs?: number;
  emptyGraceMs?: number;
  /** Wrap each peer's host-facing pipe end (e.g. to inject a byte-copy transport). */
  wrapPipe?: (end: BytePeer) => BytePeer;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Run `script` against a host built with `createVignette`, returning the
 * observable trace. Identical (script, vignette) ⇒ identical result, regardless
 * of the binding (TS/WASM) or a transport wrapper.
 */
export async function runScript(
  createVignette: () => Vignette | Promise<Vignette>,
  script: ScriptAction[],
  options: RunScriptOptions = {},
): Promise<ScriptResult> {
  const vignetteId = options.vignetteId ?? 'sim';
  const entry: ManifestEntry = {
    version: '1.0.0',
    fixedStepUs: options.fixedStepUs ?? 16_666,
    maxSubsteps: options.maxSubsteps ?? 4,
    maxPeers: options.maxPeers ?? 8,
    reconnectGraceMs: options.reconnectGraceMs,
    emptyGraceMs: options.emptyGraceMs,
    create: createVignette,
  };

  const clock = new VirtualClock(0);
  const host = VignetteHost.single(vignetteId, entry, clock);
  const peers = new Map<string, { peer: HostPeer; conn: PeerConnection }>();
  const traces: Record<string, string[]> = {};

  const requirePeer = (name: string) => {
    const p = peers.get(name);
    if (!p) throw new Error(`script references unknown peer '${name}'`);
    return p;
  };

  for (const action of script) {
    switch (action.op) {
      case 'connect': {
        const { a, b } = createLoopbackPipe();
        const end = options.wrapPipe ? options.wrapPipe(a) : a;
        const conn = host.connect(end);
        peers.set(action.peer, { peer: new HostPeer(b), conn });
        traces[action.peer] ??= [];
        break;
      }
      case 'init':
        requirePeer(action.peer).peer.init(action.vignetteId ?? vignetteId, action.payload);
        break;
      case 'join':
        requirePeer(action.peer).peer.join(action.vignetteId ?? vignetteId);
        break;
      case 'app':
        requirePeer(action.peer).peer.app(action.bytes);
        break;
      case 'leave':
        requirePeer(action.peer).peer.leave();
        break;
      case 'drop':
        requirePeer(action.peer).conn.disconnect();
        break;
      case 'advance':
        clock.advance(action.us);
        break;
      case 'pump':
        await host.pump();
        break;
      case 'poll':
        await host.poll();
        break;
    }
    await host.whenIdle();
  }

  // Serialize each peer's App + Frame stream (Ready/token excluded).
  for (const [name, { peer }] of peers) {
    traces[name] = peer.received
      .filter((e) => e.channel === Channel.App || e.channel === Channel.Frame)
      .map((e) => `${e.channel}:${e.clientId}:${hex(e.payload)}`);
  }

  return { traces, finalState: host.getState() };
}
