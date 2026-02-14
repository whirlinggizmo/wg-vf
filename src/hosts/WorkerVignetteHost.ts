import type { Vignette } from '../Vignette';
import type { VignetteHost } from '../VignetteHost';
import type { WorkerVignetteType } from '../VignetteTypes';
import { decodeEnvelope } from '../envelope/decode';
import { encodeAppEnvelope, encodeSystemEnvelope } from '../envelope/encode';
import { encodeErrorPayload, encodeReadyPayload } from '../envelope/systemPayloads';
import { MessageKind, SystemType } from '../envelope/types';

type HostState = 'IDLE' | 'INITING' | 'READY' | 'SHUTTING_DOWN' | 'CLOSED';

interface WorkerVignetteHostOptions {
  vignetteFactory?: () => Vignette | Promise<Vignette>;
  vignetteModuleUrl?: string;
  vignetteType?: WorkerVignetteType;
  fixedStepUs?: number;
  maxSubsteps?: number;
}

export class WorkerVignetteHost implements VignetteHost {
  private readonly vignetteFactory?: () => Vignette | Promise<Vignette>;
  private readonly vignetteModuleUrl?: string;
  private readonly vignetteType: WorkerVignetteType;
  private readonly fixedStepUs: number;
  private readonly maxSubsteps: number;
  private sendBytes: ((bytes: Uint8Array) => void) | null = null;
  private vignette: Vignette | null = null;
  private state: HostState = 'IDLE';
  private loopTimer: number | null = null;
  private frameId = 0;
  private stepIndex = 0;
  private accUs = 0;
  private lastUs = 0;

  constructor(options: WorkerVignetteHostOptions) {
    this.vignetteFactory = options.vignetteFactory;
    this.vignetteModuleUrl = options.vignetteModuleUrl;
    this.vignetteType = options.vignetteType ?? 'js';
    this.fixedStepUs = (options.fixedStepUs ?? 16_666) >>> 0;
    this.maxSubsteps = (options.maxSubsteps ?? 4) >>> 0;
  }

  attachToWorker(workerScope: DedicatedWorkerGlobalScope): void {
    this.setSendBytes((bytes) => {
      workerScope.postMessage(bytes, [bytes.buffer]);
    });

    workerScope.onmessage = (event: MessageEvent<ArrayBuffer | Uint8Array>) => {
      const data = event.data;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      void this.handleIncomingBytes(bytes);
    };
  }

  setSendBytes(fn: (bytes: Uint8Array) => void): void {
    this.sendBytes = fn;
  }

  async onInit(initPayload: Uint8Array): Promise<void> {
    if (this.state !== 'IDLE') {
      throw new Error(`Host cannot init in state ${this.state}`);
    }

    this.state = 'INITING';
    this.vignette = await this.instantiateVignette();
    await this.vignette.init(initPayload);
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

    if (this.loopTimer !== null) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    if (this.vignette) {
      await this.vignette.shutdown();
    }

    this.vignette = null;
    this.state = 'CLOSED';
  }

  private async handleIncomingBytes(bytes: Uint8Array): Promise<void> {
    try {
      const envelope = decodeEnvelope(bytes);

      if (envelope.messageKind === MessageKind.App) {
        await this.onAppMessage(envelope.payload);
        return;
      }

      if (envelope.systemType === SystemType.Init) {
        await this.onInit(envelope.payload);
        return;
      }

      if (envelope.systemType === SystemType.Shutdown) {
        await this.onShutdown();
      }
    } catch (err) {
      await this.handleHostError(err);
    }
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
          await this.vignette.fixedTick(this.fixedStepUs, this.stepIndex++ >>> 0);
          this.drainOutbox();
          this.accUs = (this.accUs - this.fixedStepUs) >>> 0;
          substeps += 1;
        }
      } catch (err) {
        await this.handleHostError(err);
        return;
      }

      this.loopTimer = self.setTimeout(() => {
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

  private emitSystem(systemType: SystemType, payload: Uint8Array = new Uint8Array(0)): void {
    this.sendBytes?.(encodeSystemEnvelope(systemType, payload));
  }

  private emitApp(payload: Uint8Array): void {
    this.sendBytes?.(encodeAppEnvelope(payload));
  }

  private createReadyPayload(): Uint8Array {
    return encodeReadyPayload({ ready: true, vignetteType: this.vignetteType });
  }

  private async handleHostError(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.emitSystem(SystemType.Error, encodeErrorPayload({ message }));
    await this.onShutdown();
  }

  private nowUs(): number {
    return ((performance.now() * 1000) >>> 0);
  }

  private async instantiateVignette(): Promise<Vignette> {
    if (this.vignetteFactory) {
      return await this.vignetteFactory();
    }

    if (!this.vignetteModuleUrl) {
      throw new Error('No vignetteFactory or vignetteModuleUrl provided');
    }

    const mod = await import(/* @vite-ignore */ this.vignetteModuleUrl);

    if (typeof mod.createVignette === 'function') {
      return await mod.createVignette();
    }

    if (typeof mod.default === 'function') {
      return new mod.default();
    }

    throw new Error('Vignette module must export createVignette() or a default class');
  }
}
