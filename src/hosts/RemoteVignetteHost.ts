import type { Vignette } from '../vignettes/Vignette.js';
import { decodeEnvelope } from '../envelope/decode.js';
import { MessageKind, SystemType } from '../envelope/types.js';
import { decodeInitPayload } from '../envelope/systemPayloads.js';
import { BaseVignetteHost, type ResolvedInitPayload } from './BaseVignetteHost.js';

interface BytePeer {
  send(bytes: Uint8Array): void;
  onBytes(cb: (bytes: Uint8Array) => void): () => void;
}

interface RemoteVignetteHostOptions {
  vignetteFactory?: () => Vignette | Promise<Vignette>;
  fixedStepUs?: number;
  maxSubsteps?: number;
}

export class RemoteVignetteHost extends BaseVignetteHost {
  private unbindPeer: (() => void) | null = null;

  constructor(options: RemoteVignetteHostOptions) {
    super({
      vignetteFactory: options.vignetteFactory,
      fixedStepUs: options.fixedStepUs,
      maxSubsteps: options.maxSubsteps,
      initialVignetteType: 'js',
    });
  }

  attachToPeer(peer: BytePeer): void {
    this.setSendBytes((bytes) => peer.send(bytes));
    this.unbindPeer = peer.onBytes((bytes) => {
      void this.handleIncomingBytes(bytes);
    });
  }

  protected override async beforeShutdown(): Promise<void> {
    this.unbindPeer?.();
    this.unbindPeer = null;
  }

  protected override async onReady(resolved: ResolvedInitPayload): Promise<void> {
    console.info(
      `[wg-vf] remote host initialized vignette type=${resolved.vignetteType} url=${resolved.vignetteUrl ?? '(factory)'}`,
    );
  }

  protected override resolveInitPayload(initPayload: Uint8Array): ResolvedInitPayload {
    if (this.hasVignetteFactory()) {
      return {
        vignetteType: this.getCurrentVignetteType(),
        vignetteInitPayload: initPayload,
      };
    }

    const parsed = decodeInitPayload(initPayload);
    if (parsed === null) {
      throw new Error(
        'Remote init payload must be binary with vignetteType, vignetteUrl, and initPayload',
      );
    }

    return {
      vignetteType: parsed.vignetteType,
      vignetteUrl: parsed.vignetteUrl,
      vignetteInitPayload: parsed.initPayload,
    };
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

      if (envelope.systemType === SystemType.Ping) {
        this.emitSystem(SystemType.Pong, envelope.payload);
        return;
      }

      if (envelope.systemType === SystemType.Shutdown) {
        await this.onShutdown();
      }
    } catch (err) {
      if (!this.isHandledHostError(err)) {
        await this.onHostError(err);
      }
    }
  }
}
