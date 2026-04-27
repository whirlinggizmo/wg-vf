import {
  type Vignette,
  type VignetteType,
  instantiateVignetteFromModuleUrl,
} from '../vignettes/Vignette';
import type { VignetteHost } from './VignetteHost';
import { encodeAppEnvelope, encodeSystemEnvelope } from '../envelope/encode';
import { encodeErrorPayload, encodeReadyPayload } from '../envelope/systemPayloads';
import { SystemType } from '../envelope/types';

type HostState = 'IDLE' | 'INITING' | 'READY' | 'SHUTTING_DOWN' | 'CLOSED';

export interface BaseVignetteHostOptions {
  vignetteFactory?: () => Vignette | Promise<Vignette>;
  fixedStepUs?: number;
  maxSubsteps?: number;
  initialVignetteType?: VignetteType;
}

export interface ResolvedInitPayload {
  vignetteType: VignetteType;
  vignetteUrl?: string;
  vignetteInitPayload: Uint8Array;
}

export abstract class BaseVignetteHost implements VignetteHost {
  private readonly vignetteFactory?: () => Vignette | Promise<Vignette>;
  private readonly fixedStepUs: number;
  private readonly maxSubsteps: number;
  private sendBytes: ((bytes: Uint8Array) => void) | null = null;
  private vignette: Vignette | null = null;
  private state: HostState = 'IDLE';
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private frameId = 0;
  private stepIndex = 0;
  private accUs = 0;
  private lastUs = 0;
  private currentVignetteType: VignetteType;

  protected constructor(options: BaseVignetteHostOptions) {
    this.vignetteFactory = options.vignetteFactory;
    this.currentVignetteType = options.initialVignetteType ?? 'js';
    this.fixedStepUs = (options.fixedStepUs ?? 16_666) >>> 0;
    this.maxSubsteps = (options.maxSubsteps ?? 4) >>> 0;
  }

  setSendBytes(fn: (bytes: Uint8Array) => void): void {
    this.sendBytes = fn;
  }

  async onInit(initPayload: Uint8Array): Promise<void> {
    if (this.state !== 'IDLE') {
      throw new Error(`Host cannot init in state ${this.state}`);
    }

    this.state = 'INITING';
    const resolved = this.resolveInitPayload(initPayload);
    this.currentVignetteType = resolved.vignetteType;
    this.vignette = await this.instantiateVignette(
      resolved.vignetteType,
      resolved.vignetteUrl,
    );
    await this.vignette.init(resolved.vignetteInitPayload);
    await this.onReady(resolved);
    this.state = 'READY';
    this.startTickLoop();
    this.drainOutbox();
    this.emitSystem(SystemType.Ready, this.createReadyPayload());
  }

  async onAppMessage(payload: Uint8Array): Promise<void> {
    if (this.state !== 'READY' || !this.vignette) {
      return;
    }
    await this.vignette.handleMessage(payload);
    this.drainOutbox();
  }

  async onShutdown(): Promise<void> {
    if (this.state === 'CLOSED' || this.state === 'SHUTTING_DOWN') {
      return;
    }

    this.state = 'SHUTTING_DOWN';

    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    await this.beforeShutdown();

    if (this.vignette) {
      await this.vignette.shutdown();
    }

    this.vignette = null;
    this.state = 'CLOSED';
  }

  protected abstract resolveInitPayload(initPayload: Uint8Array): ResolvedInitPayload;

  protected async onHostError(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.emitSystem(SystemType.Error, encodeErrorPayload({ message }));
    await this.onShutdown();
  }

  protected async beforeShutdown(): Promise<void> {}

  protected async onReady(_resolved: ResolvedInitPayload): Promise<void> {}

  protected getCurrentVignetteType(): VignetteType {
    return this.currentVignetteType;
  }

  protected hasVignetteFactory(): boolean {
    return this.vignetteFactory !== undefined;
  }

  protected async instantiateVignette(
    vignetteType: VignetteType,
    vignetteUrl?: string,
  ): Promise<Vignette> {
    if (this.vignetteFactory) {
      return await this.vignetteFactory();
    }

    if (!vignetteUrl) {
      throw new Error('No vignetteFactory or vignetteUrl provided');
    }

    return await instantiateVignetteFromModuleUrl(vignetteType, vignetteUrl);
  }

  protected emitSystem(
    systemType: SystemType,
    payload: Uint8Array = new Uint8Array(0),
  ): void {
    this.sendBytes?.(encodeSystemEnvelope(systemType, payload));
  }

  protected nowUs(): number {
    if (typeof performance !== 'undefined' && performance.now) {
      return (performance.now() * 1000) >>> 0;
    }
    return (Date.now() * 1000) >>> 0;
  }

  private startTickLoop(): void {
    this.lastUs = this.nowUs();

    const tick = async () => {
      if (this.state !== 'READY' || !this.vignette) {
        return;
      }

      try {
        const nowUs = this.nowUs();
        const dtUs = (nowUs - this.lastUs) >>> 0;
        this.lastUs = nowUs;

        await this.vignette.tick(dtUs, this.frameId++ >>> 0);
        this.drainOutbox();

        this.accUs = (this.accUs + dtUs) >>> 0;

        let substeps = 0;
        while (this.accUs >= this.fixedStepUs && substeps < this.maxSubsteps) {
          await this.vignette.fixedTick(
            this.fixedStepUs,
            this.stepIndex++ >>> 0,
          );
          this.drainOutbox();
          this.accUs = (this.accUs - this.fixedStepUs) >>> 0;
          substeps += 1;
        }
      } catch (err) {
        await this.onHostError(err);
        return;
      }

      this.loopTimer = setTimeout(() => {
        void tick();
      }, 0);
    };

    void tick();
  }

  private drainOutbox(): void {
    if (!this.vignette) {
      return;
    }

    while (this.vignette.outboxHasMessages()) {
      this.emitApp(this.vignette.outboxPop());
    }
  }

  private emitApp(payload: Uint8Array): void {
    this.sendBytes?.(encodeAppEnvelope(payload));
  }

  private createReadyPayload(): Uint8Array {
    return encodeReadyPayload({ ready: true, vignetteType: this.currentVignetteType });
  }
}
