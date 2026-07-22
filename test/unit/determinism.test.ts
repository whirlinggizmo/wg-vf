// DET-04 (test plan §4): the Frame channel is droppable. With one host serving
// a clean peer and a lossy peer, frame loss changes only the lossy peer's
// received frames — the reliable App/event stream is identical for both, and
// the sim is unaffected (frames are host→peer, never fed back).

import { describe, expect, test } from 'bun:test';

import { VignetteHost, type HostVignetteEntry } from '../../src/hosts/VignetteHost.js';
import type { Vignette } from '../../src/vignettes/Vignette.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { lossyPipe } from '../../src/testing/LossyPipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';
import { CounterVignette } from '../../src/testing/vignettes.js';
import { readFrameHeader } from '../../src/envelope/index.js';

const STEP = 16_666;

function entry(create: () => Vignette): HostVignetteEntry {
  return { vignetteId: 'sim', version: '1.0.0', fixedStepUs: STEP, maxSubsteps: 4, maxPeers: 8, create };
}

describe('DET-04 frame-loss tolerance', () => {
  test('lossy frame channel drops only frames; App/event stream survives intact', async () => {
    const clock = new VirtualClock(0);
    const host = new VignetteHost(entry(() => new CounterVignette(1)), clock);

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
