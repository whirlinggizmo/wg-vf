// DET-04 (test plan §4): the Frame channel is droppable. With one host serving
// a clean peer and a lossy peer, frame loss changes only the lossy peer's
// received frames — the reliable App/event stream is identical for both, and
// the sim is unaffected (frames are host→peer, never fed back).

import { describe, expect, test } from 'bun:test';

import { VignetteHost } from '../../src/hosts/VignetteHost.js';
import type { ManifestEntry } from '../../src/hosts/Manifest.js';
import type { Vignette } from '../../src/vignettes/Vignette.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { lossyPipe } from '../../src/testing/LossyPipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';
import { CounterVignette } from '../../src/testing/vignettes.js';
import { runScript, type ScriptAction } from '../../src/testing/script.js';
import type { BytePeer } from '../../src/transports/BytePeer.js';
import { readFrameHeader } from '../../src/envelope/index.js';

const STEP = 16_666;

// S1: multi-peer join/leave churn + an overload pump (6 steps, maxSubsteps 4).
function s1(): ScriptAction[] {
  return [
    { op: 'connect', peer: 'P1' },
    { op: 'init', peer: 'P1' },
    { op: 'connect', peer: 'P2' },
    { op: 'join', peer: 'P2' },
    { op: 'advance', us: STEP * 3 },
    { op: 'pump' },
    { op: 'advance', us: STEP * 6 }, // overload → drop-time clamp
    { op: 'pump' },
    { op: 'leave', peer: 'P2' },
    { op: 'advance', us: STEP * 2 },
    { op: 'pump' },
  ];
}

describe('DET-01/02 transport invariance', () => {
  test('same script + vignette yields identical traces over loopback and a byte-copy transport', async () => {
    // A transport that serializes (copies) every byte on the way to the host —
    // models a "remote" pipe that re-materializes envelopes.
    const byteCopy = (end: BytePeer): BytePeer => ({
      send: (b) => end.send(b.slice()),
      onBytes: (cb) => end.onBytes((b) => cb(b.slice())),
    });

    const plain = await runScript(() => new CounterVignette(), s1());
    const wrapped = await runScript(() => new CounterVignette(), s1(), { wrapPipe: byteCopy });

    expect(wrapped.traces).toEqual(plain.traces);
    expect(wrapped.finalState).toBe(plain.finalState);
    expect(plain.traces.P1.length).toBeGreaterThan(0);
  });
});

function entry(create: () => Vignette): ManifestEntry {
  return { version: '1.0.0', fixedStepUs: STEP, maxSubsteps: 4, maxPeers: 8, create };
}

describe('DET-04 frame-loss tolerance', () => {
  test('lossy frame channel drops only frames; App/event stream survives intact', async () => {
    const clock = new VirtualClock(0);
    const host = VignetteHost.single('sim', entry(() => new CounterVignette(1)), clock);

    // Clean founding peer.
    const cleanPipe = createLoopbackPipe();
    host.connect(cleanPipe.a);
    const clean = new HostPeer(cleanPipe.b);
    clean.init('sim');
    await host.whenIdle();

    // Second peer behind a lossy link that drops ~60% of frames.
    const lossyInner = createLoopbackPipe();
    host.connect(lossyPipe(lossyInner.a, { dropFrame: 0.6, seed: 42 }));
    const lossy = new HostPeer(lossyInner.b);
    lossy.join('sim');
    await host.whenIdle();

    for (let i = 0; i < 40; i++) {
      clock.advance(STEP);
      await host.pump();
    }

    // Counter emits a broadcast event every step (emitEvery=1) on the App
    // channel — reliable, so both peers see the exact same event stream.
    const events = (p: HostPeer) => p.apps().map((e) => Array.from(e.payload).join(','));
    expect(events(lossy)).toEqual(events(clean));
    expect(events(clean).length).toBe(40);

    // The lossy peer received strictly fewer frames...
    expect(lossy.frames().length).toBeLessThan(clean.frames().length);
    // ...and every frame it did receive is a valid, monotonically-newer sample.
    let prev = -1;
    for (const f of lossy.frames()) {
      const seq = readFrameHeader(f.payload)!.frameSeq;
      expect(seq).toBeGreaterThan(prev);
      prev = seq;
    }
    // The clean peer got the full frame stream (one per step).
    expect(clean.frames().length).toBe(40);
  });
});
