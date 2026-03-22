import { decodeEnvelope } from './envelope/decode';
import { encodeAppEnvelope, encodeSystemEnvelope } from './envelope/encode';
import { decodeErrorPayload, decodePingPayload, decodeReadyPayload, encodePingPayload } from './envelope/systemPayloads';
import { MessageKind, SystemType } from './envelope/types';
import { ReconnectingWebSocketTransport } from './transports/ReconnectingWebSocketTransport';
import type { Transport } from './transports/Transport';
import type { VignetteType } from './Vignette';

export interface LocalVignetteBridgeConfig {
  mode: 'local';
  vignetteType: VignetteType;
  moduleUrl: string;
}

export interface RemoteVignetteBridgeConfig {
  mode: 'remote';
  url: string;
}

export type VignetteBridgeConfig = LocalVignetteBridgeConfig | RemoteVignetteBridgeConfig;

export interface VignetteBridgePingRequest {
  id: number;
  method: 'ping';
  payload: Uint8Array;
}

export interface VignetteBridgeConnectRequest {
  id: number;
  method: 'connect';
  config: VignetteBridgeConfig;
}

export interface VignetteBridgeDisconnectRequest {
  id: number;
  method: 'disconnect';
}

export interface VignetteBridgeInitRequest {
  id: number;
  method: 'init';
  payload: Uint8Array;
}

export interface VignetteBridgeHandleMessageRequest {
  id: number;
  method: 'handleMessage';
  payload: Uint8Array;
}

export type VignetteBridgeRequest =
  | VignetteBridgeConnectRequest
  | VignetteBridgeDisconnectRequest
  | VignetteBridgeInitRequest
  | VignetteBridgeHandleMessageRequest
  | VignetteBridgePingRequest;

export interface VignetteBridgeSuccessResponse {
  type: 'response';
  id: number;
  ok: true;
}

export interface VignetteBridgeErrorResponse {
  type: 'response';
  id: number;
  ok: false;
  error: string;
}

export interface VignetteBridgePongResponse {
  type: 'pong';
  id: number;
  payload: Uint8Array;
}

export interface VignetteBridgeOutboxEvent {
  type: 'outbox';
  payload: Uint8Array;
}

export interface VignetteBridgeAsyncErrorEvent {
  type: 'error';
  message: string;
}

export type VignetteBridgeWorkerMessage =
  | VignetteBridgeSuccessResponse
  | VignetteBridgeErrorResponse
  | VignetteBridgePongResponse
  | VignetteBridgeOutboxEvent
  | VignetteBridgeAsyncErrorEvent;

export interface VignetteBridgePingResult {
  sequence: number;
  sentAtMs: number;
  receivedAtMs: number;
  rttMs: number;
}

interface PendingRequest {
  resolve: (payload: Uint8Array) => void;
  reject: (error: Error) => void;
}

interface PendingRemoteInit {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingRemotePing {
  resolve: (result: VignetteBridgePingResult) => void;
  reject: (error: Error) => void;
}

type RemoteState = 'DISCONNECTED' | 'CONNECTING' | 'READY' | 'ERROR' | 'CLOSED';

export class VignetteBridge {
  private readonly workerUrl: URL;
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private nextPingSequence = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingRemotePings = new Map<number, PendingRemotePing>();
  private readonly outbox: Uint8Array[] = [];

  private transport: Transport | null = null;
  private remoteState: RemoteState = 'DISCONNECTED';
  private lastInitPayload: Uint8Array | null = null;
  private pendingRemoteInit: PendingRemoteInit | null = null;
  private unbindBytes: (() => void) | null = null;
  private unbindTransportError: (() => void) | null = null;
  private unbindTransportDisconnect: (() => void) | null = null;
  private unbindTransportReconnect: (() => void) | null = null;

  constructor(workerUrl: URL = new URL('./VignetteBridgeWorker.js', import.meta.url)) {
    this.workerUrl = workerUrl;
  }

  async connect(config: VignetteBridgeConfig): Promise<void> {
    if (config.mode === 'remote') {
      await this.connectRemote(config.url);
      return;
    }

    if (this.worker || this.transport) {
      throw new Error('Vignette bridge is already connected');
    }

    const worker = new Worker(this.workerUrl, { type: 'module' });
    worker.onmessage = (event: MessageEvent<VignetteBridgeWorkerMessage>) => {
      this.handleWorkerMessage(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      const message = event.message || 'Vignette bridge worker error';
      this.rejectAll(new Error(message));
    };

    this.worker = worker;
    this.outbox.length = 0;

    try {
      await this.request({
        id: this.allocateRequestId(),
        method: 'connect',
        config,
      });
    } catch (err) {
      this.worker.terminate();
      this.worker = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.disconnectRemote();
      return;
    }

    if (!this.worker) {
      this.outbox.length = 0;
      return;
    }

    const worker = this.worker;
    this.worker = null;

    try {
      await this.request(
        {
          id: this.allocateRequestId(),
          method: 'disconnect',
        },
        worker,
      );
    } finally {
      worker.terminate();
      this.rejectAll(new Error('Vignette bridge disconnected'));
      this.outbox.length = 0;
    }
  }

  async init(payload: Uint8Array): Promise<void> {
    if (this.transport) {
      await this.initRemote(payload);
      return;
    }

    await this.requestWithPayload({
      id: this.allocateRequestId(),
      method: 'init',
      payload,
    });
  }

  async handleMessage(payload: Uint8Array): Promise<void> {
    if (this.transport) {
      const transport = this.requireTransport();
      if (this.remoteState !== 'READY') {
        throw new Error(`Cannot send app message while in state ${this.remoteState}`);
      }
      transport.send(encodeAppEnvelope(payload.slice()));
      return;
    }

    await this.requestWithPayload({
      id: this.allocateRequestId(),
      method: 'handleMessage',
      payload,
    });
  }

  async ping(): Promise<VignetteBridgePingResult> {
    const sequence = this.nextPingSequence++ >>> 0;
    const sentAtMs = this.nowMs();
    const payload = encodePingPayload({ sequence, sentAtMs });

    if (this.transport) {
      return await this.pingRemote(payload);
    }

    const pongPayload = await this.requestWithPayload({
      id: this.allocateRequestId(),
      method: 'ping',
      payload,
    });

    const decoded = decodePingPayload(pongPayload);
    if (!decoded) {
      throw new Error('Bridge worker returned invalid pong payload');
    }

    const receivedAtMs = this.nowMs();
    return {
      sequence: decoded.sequence,
      sentAtMs: decoded.sentAtMs,
      receivedAtMs,
      rttMs: receivedAtMs - decoded.sentAtMs,
    };
  }

  pollOutbox(): Uint8Array[] {
    const drained = this.outbox.slice();
    this.outbox.length = 0;
    return drained;
  }

  private async connectRemote(url: string): Promise<void> {
    if (this.worker || this.transport) {
      throw new Error('Vignette bridge is already connected');
    }

    const transport = new ReconnectingWebSocketTransport({ url });
    this.transport = transport;
    this.remoteState = 'CONNECTING';
    this.outbox.length = 0;

    this.unbindBytes = transport.onBytes((bytes) => {
      void this.handleRemoteBytes(bytes);
    });

    if (transport.onError) {
      this.unbindTransportError = transport.onError((err) => {
        this.remoteState = 'ERROR';
        this.pendingRemoteInit?.reject(err);
        this.pendingRemoteInit = null;
        this.rejectPendingRemotePings(err);
        console.error('[wg-vf] bridge transport error:', err);
      });
    }

    if (transport.onDisconnect) {
      this.unbindTransportDisconnect = transport.onDisconnect(() => {
        if (this.remoteState === 'READY') {
          this.remoteState = 'CONNECTING';
        }
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

  private async disconnectRemote(): Promise<void> {
    const transport = this.transport;
    this.transport = null;

    if (!transport) {
      this.outbox.length = 0;
      this.lastInitPayload = null;
      this.pendingRemoteInit = null;
      this.remoteState = 'CLOSED';
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
      this.outbox.length = 0;
      this.lastInitPayload = null;
      this.remoteState = 'CLOSED';
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

  private async pingRemote(payload: Uint8Array): Promise<VignetteBridgePingResult> {
    const transport = this.requireTransport();
    const decoded = decodePingPayload(payload);
    if (!decoded) {
      throw new Error('Invalid ping payload');
    }

    return await new Promise<VignetteBridgePingResult>((resolve, reject) => {
      this.pendingRemotePings.set(decoded.sequence, { resolve, reject });
      transport.send(encodeSystemEnvelope(SystemType.Ping, payload.slice()));
    });
  }

  private async handleRemoteBytes(bytes: Uint8Array): Promise<void> {
    try {
      const envelope = decodeEnvelope(bytes);

      if (envelope.messageKind === MessageKind.App) {
        this.outbox.push(envelope.payload);
        return;
      }

      if (envelope.systemType === SystemType.Ready) {
        const readyPayload = decodeReadyPayload(envelope.payload);
        const ready = readyPayload?.ready ?? true;
        this.remoteState = ready ? 'READY' : 'CONNECTING';
        if (ready) {
          this.pendingRemoteInit?.resolve();
          this.pendingRemoteInit = null;
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
        throw error;
      }
    } catch (err) {
      this.remoteState = 'ERROR';
      throw err instanceof Error ? err : new Error(String(err));
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

  private async requestWithPayload(
    request: Extract<VignetteBridgeRequest, { payload: Uint8Array }>,
  ): Promise<Uint8Array> {
    const clonedPayload = request.payload.slice();
    return await this.request(
      {
        ...request,
        payload: clonedPayload,
      },
      undefined,
      [clonedPayload.buffer as Transferable],
    );
  }

  private async request(
    request: VignetteBridgeRequest,
    workerOverride?: Worker,
    transfer: Transferable[] = [],
  ): Promise<Uint8Array> {
    const worker = workerOverride ?? this.requireWorker();

    return await new Promise<Uint8Array>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      worker.postMessage(request, transfer);
    });
  }

  private handleWorkerMessage(message: VignetteBridgeWorkerMessage): void {
    if (message.type === 'outbox') {
      this.outbox.push(message.payload);
      return;
    }

    if (message.type === 'error') {
      console.error('[wg-vf] bridge host error:', new Error(message.message));
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if (message.type === 'pong') {
      pending.resolve(message.payload);
      return;
    }
    if (message.ok) {
      pending.resolve(new Uint8Array(0));
      return;
    }
    pending.reject(new Error(message.error));
  }

  private rejectAll(error: Error): void {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const pending of entries) {
      pending.reject(error);
    }
    this.rejectPendingRemotePings(error);
  }

  private rejectPendingRemotePings(error: Error): void {
    const entries = Array.from(this.pendingRemotePings.values());
    this.pendingRemotePings.clear();
    for (const pending of entries) {
      pending.reject(error);
    }
  }

  private requireWorker(): Worker {
    if (!this.worker) {
      throw new Error('Vignette bridge is not connected');
    }
    return this.worker;
  }

  private requireTransport(): Transport {
    if (!this.transport) {
      throw new Error('Vignette bridge is not connected');
    }
    return this.transport;
  }

  private allocateRequestId(): number {
    return this.nextRequestId++;
  }

  private nowMs(): number {
    if (typeof performance !== 'undefined' && performance.now) {
      return performance.now();
    }
    return Date.now();
  }
}
