// ENV-19 / ENV-20 (test plan §1.3): on a single reliable stream the host
// coalesces frames — a stalled buffer holds only the latest unsent frame — but
// System/App traffic is never dropped by that coalescing.

import { describe, expect, test } from 'bun:test';

import { VignetteHost, type HostVignetteEntry } from '../../src/hosts/VignetteHost.js';
import type { Vignette } from '../../src/vignettes/Vignette.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { coalescingPipe } from '../../src/testing/CoalescingPipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';
import { CounterVignette } from '../../src/testing/vignettes.js';
import { readFrameHeader } from '../../src/envelope/index.js';

const STEP = 16_666;

function entry(create: () => Vignette): HostVignetteEntry {
  return { vignetteId: 'sim', version: '1.0.0', fixedStepUs: STEP, maxSubsteps: 4, maxPeers: 8, create };
}

describe('ENV-19/20 frame coalescing on a stalled reliable stream', () => {
  test('a stall keeps only the latest frame, but every App event still arrives in order', async () => {
    const clock = new VirtualClock(0);
    // emitEvery=1 → one App event per step, so App and Frame interleave.
    const host = new VignetteHost(entry(() => new CounterVignette(1)), clock);

    const inner = createLoopbackPipe();
    const link = coalescingPipe(inner.a);
    host.connect(link.pipe);
    const peer = new HostPeer(inner.b);

    peer.init('sim');
    await host.whenIdle();

    link.stall();
    for (let i = 0; i < 5; i++) {
      clock.advance(STEP);
      await host.pump();
    }
    // While stalled, nothing is delivered.
    expect(peer.frames().length).toBe(0);
    expect(peer.apps().length).toBe(0);

    link.unstall();

    // ENV-19: exactly one frame delivered — the latest (frameSeq 5).
    expect(peer.frames().length).toBe(1);
    expect(readFrameHeader(peer.frames()[0].payload)!.frameSeq).toBe(5);

    // ENV-20: all five App events survived the stall, in order.
    const steps = peer.apps().map((e) => new DataView(e.payload.buffer, e.payload.byteOffset).getUint32(1, true));
    expect(steps).toEqual([0, 1, 2, 3, 4]);
  });
});
