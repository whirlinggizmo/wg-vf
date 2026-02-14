import { decodeEnvelope } from './envelope/decode';
import { encodeAppEnvelope, encodeSystemEnvelope } from './envelope/encode';
import { decodeErrorPayload, decodeReadyPayload } from './envelope/systemPayloads';
import { MessageKind, SystemType } from './envelope/types';
import type { Transport } from './transports/Transport';

export interface VignetteClient {
  connect(initPayload: Uint8Array): Promise<void>;
  disconnect(): void;
  send(payload: Uint8Array): void;
  onMessage(cb: (payload: Uint8Array) => void): () => void;
  onReady(cb: (ready: boolean) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
}

type ClientState = 'DISCONNECTED' | 'CONNECTING' | 'READY' | 'ERROR' | 'CLOSED';

interface VignetteClientImplOptions {
  transport: Transport;
}

export class VignetteClientImpl implements VignetteClient {
  private state: ClientState = 'DISCONNECTED';
  private lastReadyValue: boolean | null = null;
  private readonly transport: Transport;
  private readonly messageListeners = new Set<(payload: Uint8Array) => void>();
  private readonly readyListeners = new Set<(ready: boolean) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();
  private unbindBytes: (() => void) | null = null;
  private unbindTransportError: (() => void) | null = null;
  private unbindTransportDisconnect: (() => void) | null = null;
  private unbindTransportReconnect: (() => void) | null = null;
  private lastInitPayload: Uint8Array | null = null;

  constructor(options: VignetteClientImplOptions) {
    this.transport = options.transport;
  }

  async connect(initPayload: Uint8Array): Promise<void> {
    if (this.state !== 'DISCONNECTED' && this.state !== 'CLOSED') {
      throw new Error(`Cannot connect while in state ${this.state}`);
    }

    this.state = 'CONNECTING';
    this.lastInitPayload = initPayload.slice();

    this.unbindBytes = this.transport.onBytes((bytes) => {
      void this.handleBytes(bytes);
    });

    if (this.transport.onError) {
      this.unbindTransportError = this.transport.onError((err) => {
        this.fail(err);
        this.disconnect();
      });
    }

    if (this.transport.onDisconnect) {
      this.unbindTransportDisconnect = this.transport.onDisconnect(() => {
        if (this.state === 'READY') {
          this.state = 'CONNECTING';
          this.notifyReady(false);
        }
      });
    }

    if (this.transport.onReconnect) {
      this.unbindTransportReconnect = this.transport.onReconnect(() => {
        void this.reinitializeAfterReconnect();
      });
    }

    await this.transport.open();

    const readyPromise = new Promise<void>((resolve, reject) => {
      const unbindReady = this.onReady((ready) => {
        if (ready) {
          unbindReady();
          unbindErr();
          resolve();
        }
      });
      const unbindErr = this.onError((err) => {
        unbindReady();
        unbindErr();
        reject(err);
      });
    });

    this.transport.send(encodeSystemEnvelope(SystemType.Init, initPayload));
    await readyPromise;
  }

  disconnect(): void {
    if (this.state === 'DISCONNECTED' || this.state === 'CLOSED') {
      return;
    }

    try {
      this.transport.send(encodeSystemEnvelope(SystemType.Shutdown));
    } catch {
      // no-op: transport may already be closed
    }

    this.transport.close();
    this.unbindBytes?.();
    this.unbindTransportError?.();
    this.unbindTransportDisconnect?.();
    this.unbindTransportReconnect?.();
    this.unbindBytes = null;
    this.unbindTransportError = null;
    this.unbindTransportDisconnect = null;
    this.unbindTransportReconnect = null;
    this.lastInitPayload = null;
    this.state = 'CLOSED';
    this.notifyReady(false);
  }

  send(payload: Uint8Array): void {
    if (this.state !== 'READY') {
      throw new Error(`Cannot send app message while in state ${this.state}`);
    }
    this.transport.send(encodeAppEnvelope(payload));
  }

  onMessage(cb: (payload: Uint8Array) => void): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onReady(cb: (ready: boolean) => void): () => void {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  onError(cb: (err: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  private async handleBytes(bytes: Uint8Array): Promise<void> {
    try {
      const envelope = decodeEnvelope(bytes);

      if (envelope.messageKind === MessageKind.App) {
        if (this.state === 'READY') {
          for (const listener of this.messageListeners) {
            listener(envelope.payload);
          }
        }
        return;
      }

      if (envelope.systemType === SystemType.Ready) {
        const readyPayload = decodeReadyPayload(envelope.payload);
        const ready = readyPayload?.ready ?? true;

        this.state = ready ? 'READY' : 'CONNECTING';
        this.notifyReady(ready);
        return;
      }

      if (envelope.systemType === SystemType.Error) {
        const errorPayload = decodeErrorPayload(envelope.payload);
        const message =
          errorPayload?.message ||
          new TextDecoder().decode(envelope.payload) ||
          'Host reported error';
        this.fail(new Error(message));
        return;
      }
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private fail(err: Error): void {
    this.notifyReady(false);
    this.state = 'ERROR';
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }

  private async reinitializeAfterReconnect(): Promise<void> {
    if (!this.lastInitPayload) {
      return;
    }

    if (this.state === 'CLOSED' || this.state === 'DISCONNECTED') {
      return;
    }

    this.state = 'CONNECTING';
    this.notifyReady(false);
    try {
      this.transport.send(encodeSystemEnvelope(SystemType.Init, this.lastInitPayload));
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private notifyReady(ready: boolean): void {
    if (this.lastReadyValue === ready) {
      return;
    }
    this.lastReadyValue = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }
}
