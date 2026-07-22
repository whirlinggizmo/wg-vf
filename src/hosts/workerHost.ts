// The TS worker host bootstrap (Part II §8). Runs a VignetteHost inside a
// worker (or any postMessage port) and bridges the port to the host as a single
// peer — the single-player / local path. The app on the other end of the port
// speaks the ordinary envelope protocol, identical to the remote path.

import { type Clock, SystemClock } from './Clock.js';
import { VignetteHost, type VignetteHostOptions } from './VignetteHost.js';
import type { Manifest } from './Manifest.js';
import { messagePortBytePeer, type MessagePortLike } from '../transports/MessagePortBytePeer.js';

export interface WorkerHostOptions extends VignetteHostOptions {
  clock?: Clock;
  /** Real-time pump interval in ms. Ignored when autopump is false. */
  pumpIntervalMs?: number;
  /** Start a wall-clock pump loop. Default true; set false to drive pump() yourself. */
  autopump?: boolean;
}

export interface WorkerHostHandle {
  host: VignetteHost;
  /** Stop the pump loop (if autopump was on). */
  stop(): void;
}

/**
 * Run a single-session host bound to `port`. Call from inside a worker with
 * `self` as the port, from the main thread with a `Worker`, or with a
 * `MessageChannel` port in tests.
 */
export function runWorkerHost(
  port: MessagePortLike,
  manifest: Manifest,
  options: WorkerHostOptions = {},
): WorkerHostHandle {
  const host = new VignetteHost(manifest, options.clock ?? new SystemClock(), {
    maxPayloadBytes: options.maxPayloadBytes,
  });
  host.connect(messagePortBytePeer(port));

  let timer: ReturnType<typeof setInterval> | null = null;
  if (options.autopump !== false) {
    timer = setInterval(() => {
      void host.pump();
    }, options.pumpIntervalMs ?? 16);
  }

  return {
    host,
    stop: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
