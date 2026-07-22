// The reference host loop (Part I §2.3, Part II §2). One pump() runs exactly
// one iteration: one tick, then the fixedTick burst, then (if any step ran) a
// frame publish. The outbox is drained after every op via the drainOutbox hook.
// dt enters the sim through a single clock read at the top of the iteration.
//
// tick/fixedTick are host-driven; a throw from either is sim-fatal (Part I
// §2.4), surfaced through onSimFatal — after which the loop refuses to pump.

import type { Clock } from './Clock.js';
import type { FixedStepEngine } from './FixedStepEngine.js';
import type { FrameView } from '../vignettes/Vignette.js';

export interface HostLoopVignette {
  tick(dtUs: number, frameId: number): void | Promise<void>;
  fixedTick(stepUs: number, stepIndex: number): void | Promise<void>;
  currentFrame?(): FrameView | null;
}

export interface HostLoopHooks {
  /** Drain the vignette outbox to peers. Called after every vignette op. */
  drainOutbox(): void;
  /** Publish the post-burst frame with the given sourceTick (Part I §1.4). */
  publishFrame(frame: FrameView, sourceTick: number): void;
  /** A host-driven op threw; the sim is fatal (Part I §2.4). */
  onSimFatal(err: unknown): void;
}

export class HostLoop {
  private frameId = 0;
  private lastUs: number;
  private stopped = false;

  constructor(
    private readonly clock: Clock,
    private readonly engine: FixedStepEngine,
    private readonly vignette: HostLoopVignette,
    private readonly hooks: HostLoopHooks,
  ) {
    this.lastUs = clock.nowUs();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Run one loop iteration. Safe to await; no-op once stopped. */
  async pump(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const now = this.clock.nowUs();
    const dtUs = (now - this.lastUs) >>> 0;
    this.lastUs = now;

    try {
      await this.vignette.tick(dtUs, this.frameId);
      this.frameId = (this.frameId + 1) >>> 0;
      this.hooks.drainOutbox();

      const steps = this.engine.plan(dtUs);
      let lastStep = -1;
      for (let i = 0; i < steps; i++) {
        lastStep = this.engine.consume();
        await this.vignette.fixedTick(this.engine.stepUs, lastStep);
        this.hooks.drainOutbox();
      }

      if (steps > 0) {
        const frame = this.vignette.currentFrame?.() ?? null;
        if (frame) {
          this.hooks.publishFrame(frame, lastStep);
        }
      }
    } catch (err) {
      this.stopped = true;
      this.hooks.onSimFatal(err);
    }
  }
}
