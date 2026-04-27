import { decodePingPayload, encodePingPayload } from './envelope/systemPayloads';
import type { VignetteType } from './vignettes/Vignette';

export interface LocalVignetteBridgeConfig {
  mode: 'local';
  vignetteType: VignetteType;
  moduleUrl: string;
}

export interface RemoteVignetteBridgeConfig {
  mode: 'remote';
  remoteUrl: string;
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

export interface VignetteBridgeConnectionStateEvent {
  type: 'connection';
  connected: boolean;
}

export type VignetteBridgeWorkerMessage =
  | VignetteBridgeSuccessResponse
  | VignetteBridgeErrorResponse
  | VignetteBridgePongResponse
  | VignetteBridgeOutboxEvent
  | VignetteBridgeAsyncErrorEvent
  | VignetteBridgeConnectionStateEvent;

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

export class VignetteBridge {
  private readonly workerUrl: URL;
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private nextPingSequence = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly outbox: Uint8Array[] = [];
  private connected = false;

  constructor(workerUrl: URL = new URL('./VignetteBridgeWorker.js', import.meta.url)) {
    this.workerUrl = workerUrl;
  }

  async connect(config: VignetteBridgeConfig): Promise<void> {
    if (this.worker) {
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
    this.connected = false;
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
    if (!this.worker) {
      this.connected = false;
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
      this.connected = false;
      worker.terminate();
      this.rejectAll(new Error('Vignette bridge disconnected'));
      this.outbox.length = 0;
    }
  }

  async init(payload: Uint8Array): Promise<void> {
    await this.requestWithPayload({
      id: this.allocateRequestId(),
      method: 'init',
      payload,
    });
  }

  async handleMessage(payload: Uint8Array): Promise<void> {
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

  /**
   * Returns true only when the bridge currently has a usable connection to the
   * hosted vignette. In remote mode this remains false until the remote host
   * reports Ready, and becomes false again during reconnecting, error, or
   * closed states.
   */
  isConnected(): boolean {
    return this.connected;
  }

  pollOutbox(): Uint8Array[] {
    const drained = this.outbox.slice();
    this.outbox.length = 0;
    return drained;
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
      this.connected = false;
      console.error('[wg-vf] bridge host error:', new Error(message.message));
      return;
    }

    if (message.type === 'connection') {
      this.connected = message.connected;
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
    this.connected = false;
    const entries = Array.from(this.pending.values());
    this.pending.clear();
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
