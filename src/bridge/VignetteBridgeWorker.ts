import { decodeEnvelope } from '../envelope/decode';
import { encodeAppEnvelope, encodeSystemEnvelope } from '../envelope/encode';
import { decodeErrorPayload, decodePingPayload, decodeReadyPayload } from '../envelope/systemPayloads';
import { MessageKind, SystemType } from '../envelope/types';
import { LocalVignetteHost } from '../hosts/LocalVignetteHost';
import { ReconnectingWebSocketTransport } from '../transports/ReconnectingWebSocketTransport';
import type { Transport } from '../transports/Transport';
import type {
  LocalVignetteBridgeConfig,
  RemoteVignetteBridgeConfig,
  VignetteBridgeRequest,
  VignetteBridgeWorkerMessage,
  VignetteBridgePingResult,
} from './VignetteBridge';
import type { VignetteHost } from '../hosts/VignetteHost';

type RemoteState = 'DISCONNECTED' | 'CONNECTING' | 'READY' | 'ERROR' | 'CLOSED';

interface PendingRemoteInit {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingRemotePing {
  resolve: (result: VignetteBridgePingResult) => void;
  reject: (error: Error) => void;
}

class VignetteBridgeWorkerRuntime {
  private host: VignetteHost | null = null;
  private transport: Transport | null = null;
  private remoteState: RemoteState = 'DISCONNECTED';
  private lastInitPayload: Uint8Array | null = null;
  private pendingRemoteInit: PendingRemoteInit | null = null;
  private readonly pendingRemotePings = new Map<number, PendingRemotePing>();
  private unbindBytes: (() => void) | null = null;
  private unbindTransportError: (() => void) | null = null;
  private unbindTransportDisconnect: (() => void) | null = null;
  private unbindTransportReconnect: (() => void) | null = null;

  attach(workerScope: DedicatedWorkerGlobalScope): void {
    workerScope.onmessage = (event: MessageEvent<VignetteBridgeRequest>) => {
      void this.handleRequest(workerScope, event.data);
    };
  }

  private emitConnectionState(
    workerScope: DedicatedWorkerGlobalScope,
    connected: boolean,
  ): void {
    this.postMessage(workerScope, { type: 'connection', connected });
  }

  private async handleRequest(
    workerScope: DedicatedWorkerGlobalScope,
    request: VignetteBridgeRequest,
  ): Promise<void> {
    try {
      const payload = await this.dispatch(workerScope, request);
      if (request.method === 'ping') {
        this.postMessage(
          workerScope,
          { type: 'pong', id: request.id, payload: payload ?? new Uint8Array(0) },
          payload ? [payload.buffer as Transferable] : [],
        );
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
        await this.disconnect(workerScope);
        return undefined;
      case 'init':
        if (this.transport) {
          await this.initRemote(request.payload);
          return undefined;
        }
        await this.requireHost().onInit(request.payload);
        return undefined;
      case 'handleMessage':
        if (this.transport) {
          this.handleMessageRemote(request.payload);
          return undefined;
        }
        await this.requireHost().onAppMessage(request.payload);
        return undefined;
      case 'ping':
        if (this.transport) {
          return await this.pingRemote(request.payload);
        }
        if (!this.host) {
          throw new Error('Vignette bridge is not connected');
        }
        return request.payload;
    }
  }

  private async connect(
    workerScope: DedicatedWorkerGlobalScope,
    config: LocalVignetteBridgeConfig | RemoteVignetteBridgeConfig,
  ): Promise<void> {
    await this.disconnect();

    if (config.mode === 'remote') {
      await this.connectRemote(workerScope, config.remoteUrl);
      return;
    }

    const host = new LocalVignetteHost({
      vignetteType: config.vignetteType,
      vignetteUrl: config.moduleUrl,
    });
    host.setSendBytes((bytes) => {
      this.handleHostBytes(workerScope, bytes);
    });
    this.host = host;
    this.emitConnectionState(workerScope, true);
  }

  private async disconnect(workerScope?: DedicatedWorkerGlobalScope): Promise<void> {
    const host = this.host;
    this.host = null;

    if (host) {
      await host.onShutdown();
    }

    await this.disconnectRemote(workerScope);
    if (workerScope) {
      this.emitConnectionState(workerScope, false);
    }
  }

  private async connectRemote(
    workerScope: DedicatedWorkerGlobalScope,
    url: string,
  ): Promise<void> {
    const transport = new ReconnectingWebSocketTransport({ url });
    this.transport = transport;
    this.remoteState = 'CONNECTING';
    this.lastInitPayload = null;

    this.unbindBytes = transport.onBytes((bytes) => {
      void this.handleRemoteBytes(workerScope, bytes);
    });

    if (transport.onError) {
      this.unbindTransportError = transport.onError((err) => {
        this.remoteState = 'ERROR';
        this.pendingRemoteInit?.reject(err);
        this.pendingRemoteInit = null;
        this.rejectPendingRemotePings(err);
        this.emitConnectionState(workerScope, false);
        this.postMessage(workerScope, {
          type: 'error',
          message: `[wg-vf] bridge transport error: ${err.message}`,
        });
      });
    }

    if (transport.onDisconnect) {
      this.unbindTransportDisconnect = transport.onDisconnect(() => {
        if (this.remoteState === 'READY') {
          this.remoteState = 'CONNECTING';
        }
        this.emitConnectionState(workerScope, false);
      });
    }

    if (transport.onReconnect) {
      this.unbindTransportReconnect = transport.onReconnect(() => {
        void this.reinitializeAfterReconnect();
      });
    }

    try {
      await transport.open();
    } catch (err) {
      this.unbindRemoteTransport();
      this.transport = null;
      this.remoteState = 'ERROR';
      throw err;
    }
  }

  private async disconnectRemote(workerScope?: DedicatedWorkerGlobalScope): Promise<void> {
    const transport = this.transport;
    this.transport = null;

    if (!transport) {
      this.lastInitPayload = null;
      this.pendingRemoteInit = null;
      this.remoteState = 'CLOSED';
      if (workerScope) {
        this.emitConnectionState(workerScope, false);
      }
      return;
    }

    try {
      if (
        this.remoteState === 'READY' ||
        this.remoteState === 'CONNECTING' ||
        this.remoteState === 'ERROR'
      ) {
        try {
          transport.send(encodeSystemEnvelope(SystemType.Shutdown));
        } catch {
          // no-op
        }
      }
    } finally {
      transport.close();
      this.pendingRemoteInit?.reject(new Error('Vignette bridge disconnected'));
      this.pendingRemoteInit = null;
      this.rejectPendingRemotePings(new Error('Vignette bridge disconnected'));
      this.unbindRemoteTransport();
      this.lastInitPayload = null;
      this.remoteState = 'CLOSED';
      if (workerScope) {
        this.emitConnectionState(workerScope, false);
      }
    }
  }

  private async initRemote(payload: Uint8Array): Promise<void> {
    const transport = this.requireTransport();
    this.remoteState = 'CONNECTING';
    this.lastInitPayload = payload.slice();

    await new Promise<void>((resolve, reject) => {
      this.pendingRemoteInit = { resolve, reject };
      transport.send(encodeSystemEnvelope(SystemType.Init, payload.slice()));
    });
  }

  private handleMessageRemote(payload: Uint8Array): void {
    const transport = this.requireTransport();
    if (this.remoteState !== 'READY') {
      throw new Error(`Cannot send app message while in state ${this.remoteState}`);
    }
    transport.send(encodeAppEnvelope(payload.slice()));
  }

  private async pingRemote(payload: Uint8Array): Promise<Uint8Array> {
    const transport = this.requireTransport();
    const decoded = decodePingPayload(payload);
    if (!decoded) {
      throw new Error('Invalid ping payload');
    }

    await new Promise<VignetteBridgePingResult>((resolve, reject) => {
      this.pendingRemotePings.set(decoded.sequence, { resolve, reject });
      transport.send(encodeSystemEnvelope(SystemType.Ping, payload.slice()));
    });

    return payload;
  }

  private async handleRemoteBytes(
    workerScope: DedicatedWorkerGlobalScope,
    bytes: Uint8Array,
  ): Promise<void> {
    try {
      const envelope = decodeEnvelope(bytes);

      if (envelope.messageKind === MessageKind.App) {
        this.postMessage(workerScope, { type: 'outbox', payload: envelope.payload }, [
          envelope.payload.buffer as Transferable,
        ]);
        return;
      }

      if (envelope.systemType === SystemType.Ready) {
        const readyPayload = decodeReadyPayload(envelope.payload);
        const ready = readyPayload?.ready ?? true;
        this.remoteState = ready ? 'READY' : 'CONNECTING';
        if (ready) {
          this.emitConnectionState(workerScope, true);
          this.pendingRemoteInit?.resolve();
          this.pendingRemoteInit = null;
        } else {
          this.emitConnectionState(workerScope, false);
        }
        return;
      }

      if (envelope.systemType === SystemType.Ping) {
        this.requireTransport().send(encodeSystemEnvelope(SystemType.Pong, envelope.payload.slice()));
        return;
      }

      if (envelope.systemType === SystemType.Pong) {
        const payload = decodePingPayload(envelope.payload);
        if (!payload) {
          throw new Error('Received invalid pong payload');
        }
        const pendingPing = this.pendingRemotePings.get(payload.sequence);
        if (!pendingPing) {
          return;
        }
        this.pendingRemotePings.delete(payload.sequence);
        const receivedAtMs = this.nowMs();
        pendingPing.resolve({
          sequence: payload.sequence,
          sentAtMs: payload.sentAtMs,
          receivedAtMs,
          rttMs: receivedAtMs - payload.sentAtMs,
        });
        return;
      }

      if (envelope.systemType === SystemType.Error) {
        const errorPayload = decodeErrorPayload(envelope.payload);
        const message =
          errorPayload?.message ||
          new TextDecoder().decode(envelope.payload) ||
          'Host reported error';
        this.remoteState = 'ERROR';
        const error = new Error(message);
        this.pendingRemoteInit?.reject(error);
        this.pendingRemoteInit = null;
        this.rejectPendingRemotePings(error);
        this.emitConnectionState(workerScope, false);
        throw error;
      }
    } catch (err) {
      this.remoteState = 'ERROR';
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitConnectionState(workerScope, false);
      this.postMessage(workerScope, {
        type: 'error',
        message: error.message,
      });
    }
  }

  private async reinitializeAfterReconnect(): Promise<void> {
    if (!this.transport || !this.lastInitPayload) {
      return;
    }

    if (this.remoteState === 'CLOSED' || this.remoteState === 'DISCONNECTED') {
      return;
    }

    this.remoteState = 'CONNECTING';
    this.transport.send(encodeSystemEnvelope(SystemType.Init, this.lastInitPayload.slice()));
  }

  private unbindRemoteTransport(): void {
    this.unbindBytes?.();
    this.unbindTransportError?.();
    this.unbindTransportDisconnect?.();
    this.unbindTransportReconnect?.();
    this.unbindBytes = null;
    this.unbindTransportError = null;
    this.unbindTransportDisconnect = null;
    this.unbindTransportReconnect = null;
  }

  private rejectPendingRemotePings(error: Error): void {
    const entries = Array.from(this.pendingRemotePings.values());
    this.pendingRemotePings.clear();
    for (const pending of entries) {
      pending.reject(error);
    }
  }

  private requireHost(): VignetteHost {
    if (!this.host) {
      throw new Error('Vignette bridge is not connected');
    }
    return this.host;
  }

  private requireTransport(): Transport {
    if (!this.transport) {
      throw new Error('Vignette bridge is not connected');
    }
    return this.transport;
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
      this.emitConnectionState(workerScope, false);
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

  private nowMs(): number {
    if (typeof performance !== 'undefined' && performance.now) {
      return performance.now();
    }
    return Date.now();
  }
}

const runtime = new VignetteBridgeWorkerRuntime();
runtime.attach(self as DedicatedWorkerGlobalScope);
