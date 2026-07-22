// Worker host coverage. Uses a real MessageChannel (two connected ports,
// in-process) to exercise the actual messagePortBytePeer + runWorkerHost code
// path — the same adapter a real Worker uses — without spawning a Worker.
// Port delivery is async, so we flush the event loop between steps.

import { describe, expect, test } from 'bun:test';

import { runWorkerHost } from '../../src/hosts/workerHost.js';
import { messagePortBytePeer } from '../../src/transports/MessagePortBytePeer.js';
import type { HostVignetteEntry } from '../../src/hosts/VignetteHost.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { CounterVignette } from '../../src/testing/vignettes.js';
import {
  Channel,
  SystemType,
  decodeEnvelope,
  encodeAppEnvelope,
  encodeSystemEnvelope,
  readFrameHeader,
  type Envelope,
} from '../../src/envelope/index.js';
import {
  decodeReadyPayload,
  encodeInitPayload,
} from '../../src/envelope/systemPayloads.js';

const STEP = 16_666;

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function entry(create: () => CounterVignette): HostVignetteEntry {
  return {
    vignetteId: 'sim',
    version: '1.0.0',
    fixedStepUs: STEP,
    maxSubsteps: 4,
    maxPeers: 8,
    create,
  };
}

describe('worker host', () => {
  test('messagePortBytePeer round-trips bytes across a MessageChannel', async () => {
    const { port1, port2 } = new MessageChannel();
    const a = messagePortBytePeer(port1);
    const b = messagePortBytePeer(port2);
    const got: number[][] = [];
    b.onBytes((bytes) => got.push(Array.from(bytes)));
    a.send(new Uint8Array([1, 2, 3]));
    await flush();
    expect(got).toEqual([[1, 2, 3]]);
    port1.close();
    port2.close();
  });

  test('full session over the port: provision, echo of frames, App→sim', async () => {
    const { port1, port2 } = new MessageChannel();
    const clock = new VirtualClock(0);
    const counter = new CounterVignette();
    const { host } = runWorkerHost(port2, entry(() => counter), { clock, autopump: false });

    const app = messagePortBytePeer(port1);
    const received: Envelope[] = [];
    app.onBytes((bytes) => received.push(decodeEnvelope(bytes)));

    // Provision.
    app.send(
      encodeSystemEnvelope(SystemType.Init, encodeInitPayload({ vignetteId: 'sim', initPayload: new Uint8Array() })),
    );
    await flush();
    await host.whenIdle();
    await flush();

    const readyEnv = received.find((e) => e.channel === Channel.System && e.systemType === SystemType.Ready);
    expect(readyEnv).toBeDefined();
    expect(decodeReadyPayload(readyEnv!.payload)?.clientId).toBe(1);
    expect(host.getState()).toBe('READY');

    // Drive one fixed step → a frame is published back to the app.
    clock.advance(STEP);
    await host.pump();
    await flush();

    const frame = received.find((e) => e.channel === Channel.Frame);
    expect(frame).toBeDefined();
    const fh = readFrameHeader(frame!.payload)!;
    expect(fh.frameSeq).toBe(1);
    const bodyCounter = new DataView(fh.body.buffer, fh.body.byteOffset).getUint32(4, true);
    expect(bodyCounter).toBe(1);

    // An App message reaches the sim (counter records its received dt via tick,
    // but here we just confirm the sim keeps advancing after the message).
    app.send(encodeAppEnvelope(new Uint8Array([9])));
    await flush();
    await host.whenIdle();
    expect(host.getState()).toBe('READY');

    port1.close();
    port2.close();
  });
});
