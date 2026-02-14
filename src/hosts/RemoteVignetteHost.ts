import type { Vignette } from "../Vignette";
import type { VignetteHost } from "../VignetteHost";
import { isVignetteType, type VignetteType } from "../VignetteTypes";
import { createWasmInstance, type WasmVignetteInstance } from "../WasmVignette";
import { decodeEnvelope } from "../envelope/decode";
import { encodeAppEnvelope, encodeSystemEnvelope } from "../envelope/encode";
import {
  encodeErrorPayload,
  encodeReadyPayload,
} from "../envelope/systemPayloads";
import { MessageKind, SystemType } from "../envelope/types";

type HostState = "IDLE" | "INITING" | "READY" | "SHUTTING_DOWN" | "CLOSED";

interface BytePeer {
  send(bytes: Uint8Array): void;
  onBytes(cb: (bytes: Uint8Array) => void): () => void;
}

interface RemoteVignetteHostOptions {
  vignetteFactory?: () => Vignette | Promise<Vignette>;
  vignetteUrl?: string;
  vignetteType?: VignetteType;
  fixedStepUs?: number;
  maxSubsteps?: number;
}

export class RemoteVignetteHost implements VignetteHost {
  private readonly vignetteFactory?: () => Vignette | Promise<Vignette>;
  private readonly defaultVignetteUrl?: string;
  private readonly defaultVignetteType: VignetteType;
  private readonly fixedStepUs: number;
  private readonly maxSubsteps: number;
  private sendBytes: ((bytes: Uint8Array) => void) | null = null;
  private vignette: Vignette | null = null;
  private state: HostState = "IDLE";
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private unbindPeer: (() => void) | null = null;
  private frameId = 0;
  private stepIndex = 0;
  private accUs = 0;
  private lastUs = 0;
  private currentVignetteType: VignetteType;

  constructor(options: RemoteVignetteHostOptions) {
    this.vignetteFactory = options.vignetteFactory;
    this.defaultVignetteUrl = options.vignetteUrl;
    this.defaultVignetteType = options.vignetteType ?? "js";
    this.currentVignetteType = this.defaultVignetteType;
    this.fixedStepUs = (options.fixedStepUs ?? 16_666) >>> 0;
    this.maxSubsteps = (options.maxSubsteps ?? 4) >>> 0;
  }

  attachToPeer(peer: BytePeer): void {
    this.setSendBytes((bytes) => peer.send(bytes));
    this.unbindPeer = peer.onBytes((bytes) => {
      void this.handleIncomingBytes(bytes);
    });
  }

  setSendBytes(fn: (bytes: Uint8Array) => void): void {
    this.sendBytes = fn;
  }

  async onInit(initPayload: Uint8Array): Promise<void> {
    if (this.state !== "IDLE") {
      throw new Error(`Host cannot init in state ${this.state}`);
    }

    this.state = "INITING";
    const resolved = this.resolveInitPayload(initPayload);
    this.currentVignetteType = resolved.vignetteType;
    this.vignette = await this.instantiateVignette(
      resolved.vignetteType,
      resolved.vignetteUrl,
    );
    await this.vignette.init(resolved.vignetteInitPayload);
    console.info(
      `[wg-vf] remote host initialized vignette type=${resolved.vignetteType} url=${resolved.vignetteUrl ?? "(factory)"}`,
    );
    this.state = "READY";
    this.startTickLoop();
    this.drainOutbox();
    this.emitSystem(SystemType.Ready, this.createReadyPayload());
  }

  async onAppMessage(payload: Uint8Array): Promise<void> {
    if (this.state !== "READY" || !this.vignette) {
      return;
    }
    await this.vignette.handleMessage(payload);
    this.drainOutbox();
  }

  async onShutdown(): Promise<void> {
    if (this.state === "CLOSED" || this.state === "SHUTTING_DOWN") {
      return;
    }

    this.state = "SHUTTING_DOWN";

    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    this.unbindPeer?.();
    this.unbindPeer = null;

    if (this.vignette) {
      await this.vignette.shutdown();
    }

    this.vignette = null;
    this.state = "CLOSED";
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
      if (this.state !== "READY" || !this.vignette) {
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
        await this.handleHostError(err);
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

  private emitSystem(
    systemType: SystemType,
    payload: Uint8Array = new Uint8Array(0),
  ): void {
    this.sendBytes?.(encodeSystemEnvelope(systemType, payload));
  }

  private emitApp(payload: Uint8Array): void {
    this.sendBytes?.(encodeAppEnvelope(payload));
  }

  private createReadyPayload(): Uint8Array {
    return encodeReadyPayload({ ready: true, vignetteType: this.currentVignetteType });
  }

  private async handleHostError(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.emitSystem(SystemType.Error, encodeErrorPayload({ message }));
    await this.onShutdown();
  }

  private nowUs(): number {
    if (typeof performance !== "undefined" && performance.now) {
      return (performance.now() * 1000) >>> 0;
    }
    return (Date.now() * 1000) >>> 0;
  }

  private async instantiateVignette(
    vignetteType: VignetteType,
    vignetteUrl?: string,
  ): Promise<Vignette> {
    if (this.vignetteFactory) {
      return await this.vignetteFactory();
    }

    if (!vignetteUrl) {
      throw new Error("No vignetteFactory or vignetteUrl provided");
    }

    // wasm loader
    if (vignetteType === "wasm") {
      const moduleFactory = (await import(/* @vite-ignore */ vignetteUrl))
        .default as (opts?: {
        locateFile?: (path: string) => string;
      }) => Promise<WasmVignetteInstance>;

      if (typeof moduleFactory !== "function") {
        throw new Error(
          "WASM vignette module must default-export an Emscripten module factory",
        );
      }


      // `moduleFactory` comes from the generated Emscripten JS module's default export.
      // The JS loader has already been imported above; now we invoke that factory to create
      // a runtime module instance (HEAPU8 + exported `_vf_*` functions).
      const wasmDirUrl = new URL("./", vignetteUrl).href;
      const wasmModule = await moduleFactory({
        // `locateFile` is a standard Emscripten module option.
        // We provide it so any side files (especially `.wasm`) resolve relative to the
        // vignette loader URL, which avoids runtime path surprises across environments.
        locateFile: (path: string) => new URL(path, wasmDirUrl).href,
      });
      return createWasmInstance(wasmModule);
    } else { // js loading
      const mod = await import(/* @vite-ignore */ vignetteUrl);

      if (typeof mod.createVignette === "function") {
        return await mod.createVignette();
      }

      if (typeof mod.default === "function") {
        return new mod.default();
      }

      throw new Error(
        "Vignette module must export createVignette() or a default class",
      );
    }
  }

  private resolveInitPayload(initPayload: Uint8Array): {
    vignetteType: VignetteType;
    vignetteUrl?: string;
    vignetteInitPayload: Uint8Array;
  } {
    const fallback = {
      vignetteType: this.defaultVignetteType,
      vignetteUrl: this.defaultVignetteUrl,
      vignetteInitPayload: initPayload,
    };

    try {
      const parsed = JSON.parse(new TextDecoder().decode(initPayload)) as {
        vignetteType?: unknown;
        vignetteUrl?: unknown;
        initPayload?: unknown;
      };

      const vignetteType =
        isVignetteType(parsed?.vignetteType)
          ? parsed.vignetteType
          : this.defaultVignetteType;
      const vignetteUrl =
        typeof parsed?.vignetteUrl === "string"
          ? parsed.vignetteUrl
          : this.defaultVignetteUrl;
      const vignetteInitPayload =
        parsed && Object.prototype.hasOwnProperty.call(parsed, "initPayload")
          ? new TextEncoder().encode(JSON.stringify(parsed.initPayload))
          : initPayload;

      return {
        vignetteType,
        vignetteUrl,
        vignetteInitPayload,
      };
    } catch {
      return fallback;
    }
  }
}
