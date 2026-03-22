import { decodeEnvelope } from './envelope/decode';
import { decodeErrorPayload } from './envelope/systemPayloads';
import { MessageKind, SystemType } from './envelope/types';
import { LocalVignetteHost } from './hosts/LocalVignetteHost';
import type {
  VignetteBridgeRequest,
  VignetteBridgeWorkerMessage,
  LocalVignetteBridgeConfig,
} from './VignetteBridge';
import type { VignetteHost } from './VignetteHost';

class VignetteBridgeWorkerRuntime {
  private host: VignetteHost | null = null;

  attach(workerScope: DedicatedWorkerGlobalScope): void {
    workerScope.onmessage = (event: MessageEvent<VignetteBridgeRequest>) => {
      void this.handleRequest(workerScope, event.data);
    };
  }

  private async handleRequest(
    workerScope: DedicatedWorkerGlobalScope,
    request: VignetteBridgeRequest,
  ): Promise<void> {
    try {
      const payload = await this.dispatch(workerScope, request);
      if (request.method === 'ping') {
        this.postMessage(workerScope, { type: 'pong', id: request.id, payload: payload ?? new Uint8Array(0) }, payload ? [payload.buffer as Transferable] : []);
        return;
      }
      this.postMessage(workerScope, { type: 'response', id: request.id, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage(workerScope, { type: 'response', id: request.id, ok: false, error: message });
    }
  }

  private async dispatch(
    workerScope: DedicatedWorkerGlobalScope,
    request: VignetteBridgeRequest,
  ): Promise<Uint8Array | undefined> {
    switch (request.method) {
      case 'connect':
        await this.connect(workerScope, request.config);
        return undefined;
      case 'disconnect':
        await this.disconnect();
        return undefined;
      case 'init':
        await this.requireHost().onInit(request.payload);
        return undefined;
      case 'handleMessage':
        await this.requireHost().onAppMessage(request.payload);
        return undefined;
      case 'ping':
        this.requireHost();
        return request.payload;
    }
  }

  private async connect(
    workerScope: DedicatedWorkerGlobalScope,
    config: LocalVignetteBridgeConfig | { mode: 'remote'; url: string },
  ): Promise<void> {
    await this.disconnect();

    if (config.mode === 'remote') {
      throw new Error('Remote bridge mode is not implemented yet');
    }

    const host = new LocalVignetteHost({
      vignetteType: config.vignetteType,
      vignetteUrl: config.moduleUrl,
    });
    host.setSendBytes((bytes) => {
      this.handleHostBytes(workerScope, bytes);
    });
    this.host = host;
  }

  private async disconnect(): Promise<void> {
    if (!this.host) {
      return;
    }

    try {
      await this.host.onShutdown();
    } finally {
      this.host = null;
    }
  }

  private requireHost(): VignetteHost {
    if (!this.host) {
      throw new Error('Vignette bridge is not connected');
    }
    return this.host;
  }

  private handleHostBytes(workerScope: DedicatedWorkerGlobalScope, bytes: Uint8Array): void {
    const envelope = decodeEnvelope(bytes);

    if (envelope.messageKind === MessageKind.App) {
      this.postMessage(workerScope, { type: 'outbox', payload: envelope.payload }, [
        envelope.payload.buffer as Transferable,
      ]);
      return;
    }

    if (envelope.systemType === SystemType.Error) {
      const payload = decodeErrorPayload(envelope.payload);
      this.postMessage(workerScope, {
        type: 'error',
        message: payload?.message ?? 'Host reported error',
      });
    }
  }

  private postMessage(
    workerScope: DedicatedWorkerGlobalScope,
    message: VignetteBridgeWorkerMessage,
    transfer: Transferable[] = [],
  ): void {
    workerScope.postMessage(message, transfer);
  }
}

const runtime = new VignetteBridgeWorkerRuntime();
runtime.attach(self as DedicatedWorkerGlobalScope);
