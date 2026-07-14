import type { Vignette } from './Vignette.js';

type WasmExportFn = (...args: number[]) => number;

interface WasmCallExports {
  vf_init: WasmExportFn;
  vf_tick: WasmExportFn;
  vf_fixed_tick: WasmExportFn;
  vf_handle_message: WasmExportFn;
  vf_shutdown: WasmExportFn;
  vf_outbox_offset: WasmExportFn;
  vf_outbox_capacity?: WasmExportFn;
  vf_inbox_staging_offset?: WasmExportFn;
  vf_inbox_staging_capacity?: WasmExportFn;
  vf_mem_alloc?: WasmExportFn;
  vf_mem_free?: WasmExportFn;
}

type HeapU8Provider = () => Uint8Array;

export interface WasmVignetteOptions {
  inboxStagingOffset?: number;
  inboxStagingCapacity?: number;
}

export interface WasmVignetteInstance {
  HEAPU8: Uint8Array;
  _vf_init: WasmExportFn;
  _vf_tick: WasmExportFn;
  _vf_fixed_tick: WasmExportFn;
  _vf_handle_message: WasmExportFn;
  _vf_shutdown: WasmExportFn;
  _vf_outbox_offset: WasmExportFn;
  _vf_outbox_capacity?: WasmExportFn;
  _vf_inbox_staging_offset?: WasmExportFn;
  _vf_inbox_staging_capacity?: WasmExportFn;
  _vf_mem_alloc?: WasmExportFn;
  _vf_mem_free?: WasmExportFn;
}

class WasmVignette implements Vignette {
  private readonly getHeapU8: HeapU8Provider;
  private readonly exports: WasmCallExports;
  private readonly outbox: Uint8Array[] = [];
  private readonly inboxStagingOffset?: number;
  private readonly inboxStagingCapacity?: number;

  constructor(
    getHeapU8: HeapU8Provider,
    exports: WasmCallExports,
    inboxStagingOffset?: number,
    inboxStagingCapacity?: number,
  ) {
    this.getHeapU8 = getHeapU8;
    this.exports = exports;
    this.inboxStagingOffset = inboxStagingOffset;
    this.inboxStagingCapacity = inboxStagingCapacity;
  }

  async init(initPayload: Uint8Array): Promise<void> {
    this.callWithPayload('vf_init', initPayload);
  }

  async tick(dtUs: number, frameId: number): Promise<void> {
    this.callNoPayload('vf_tick', dtUs >>> 0, frameId >>> 0);
  }

  async fixedTick(stepUs: number, stepIndex: number): Promise<void> {
    this.callNoPayload('vf_fixed_tick', stepUs >>> 0, stepIndex >>> 0);
  }

  async handleMessage(payload: Uint8Array): Promise<void> {
    this.callWithPayload('vf_handle_message', payload);
  }

  async shutdown(): Promise<void> {
    this.callNoPayload('vf_shutdown');
  }

  outboxHasMessages(): boolean {
    return this.outbox.length > 0;
  }

  outboxPop(): Uint8Array {
    const msg = this.outbox.shift();
    if (!msg) {
      throw new Error('WASM outbox is empty');
    }
    return msg;
  }

  private callNoPayload(name: keyof WasmCallExports, ...args: number[]): void {
    const fn = this.exports[name];
    if (typeof fn !== 'function') {
      throw new Error(`Missing WASM export: ${String(name)}`);
    }

    const rc = fn(...args);
    if ((rc >>> 0) !== 0) {
      throw new Error(`WASM ${String(name)} failed with code ${rc >>> 0}`);
    }

    this.drainOutboxRing();
  }

  private callWithPayload(name: 'vf_init' | 'vf_handle_message', payload: Uint8Array): void {
    const fn = this.exports[name];
    if (typeof fn !== 'function') {
      throw new Error(`Missing WASM export: ${name}`);
    }

    const [ptr, releaser] = this.stagePayload(payload);

    try {
      const rc = fn(ptr >>> 0, payload.length >>> 0);
      if ((rc >>> 0) !== 0) {
        throw new Error(`WASM ${name} failed with code ${rc >>> 0}`);
      }
      this.drainOutboxRing();
    } finally {
      releaser();
    }
  }

  private stagePayload(payload: Uint8Array): [number, () => void] {
    const alloc = this.resolveAlloc();

    if (alloc) {
      const ptr = alloc.alloc(payload.length >>> 0) >>> 0;
      if (ptr === 0) {
        throw new Error('WASM allocation failed');
      }

      this.heapU8().set(payload, ptr);
      return [ptr, () => alloc.free?.(ptr >>> 0)];
    }

    const stagingOffset =
      this.inboxStagingOffset ??
      (typeof this.exports.vf_inbox_staging_offset === 'function'
        ? this.exports.vf_inbox_staging_offset() >>> 0
        : undefined);

    const stagingCap =
      this.inboxStagingCapacity ??
      (typeof this.exports.vf_inbox_staging_capacity === 'function'
        ? this.exports.vf_inbox_staging_capacity() >>> 0
        : undefined);

    if (stagingOffset === undefined || stagingCap === undefined) {
      throw new Error(
        'WASM input staging unavailable: provide allocator exports or inbox staging offsets',
      );
    }

    if (payload.length > stagingCap) {
      throw new Error(`WASM input payload too large (${payload.length} > ${stagingCap})`);
    }

    this.heapU8().set(payload, stagingOffset);
    return [stagingOffset, () => undefined];
  }

  private resolveAlloc(): { alloc: (size: number) => number; free?: (ptr: number) => void } | null {
    if (typeof this.exports.vf_mem_alloc === 'function') {
      return {
        alloc: (size: number) => this.exports.vf_mem_alloc!(size >>> 0) >>> 0,
        free:
          typeof this.exports.vf_mem_free === 'function'
            ? (ptr: number) => {
                this.exports.vf_mem_free!(ptr >>> 0);
              }
            : undefined,
      };
    }

    return null;
  }

  private drainOutboxRing(): void {
    const outboxBase = this.exports.vf_outbox_offset() >>> 0;
    const view = this.memoryView();
    const cap = view.getUint32(outboxBase + 8, true) >>> 0;
    const payloadBase = outboxBase + 12;

    if (cap === 0) {
      return;
    }

    let head = view.getUint32(outboxBase, true) >>> 0;
    const tail = view.getUint32(outboxBase + 4, true) >>> 0;

    while (head !== tail) {
      const lenBytes = this.readRingBytes(payloadBase, cap, head, 4);
      const lenView = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4);
      const len = lenView.getUint32(0, true) >>> 0;
      const payloadOffset = (head + 4) % cap;
      const payload = this.readRingBytes(payloadBase, cap, payloadOffset, len);

      this.outbox.push(payload);
      head = (payloadOffset + len) % cap;
      view.setUint32(outboxBase, head >>> 0, true);
    }
  }

  private readRingBytes(
    payloadBase: number,
    cap: number,
    offset: number,
    len: number,
  ): Uint8Array {
    const heap = this.heapU8();
    const out = new Uint8Array(len >>> 0);

    if (len === 0) {
      return out;
    }

    const first = Math.min(len, cap - offset);
    out.set(heap.subarray(payloadBase + offset, payloadBase + offset + first), 0);

    if (first < len) {
      const remain = len - first;
      out.set(heap.subarray(payloadBase, payloadBase + remain), first);
    }

    return out;
  }

  private heapU8(): Uint8Array {
    return this.getHeapU8();
  }

  private memoryView(): DataView {
    const heap = this.heapU8();
    return new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
  }
}

export function createWasmInstance(
  module: WasmVignetteInstance,
  options?: Pick<WasmVignetteOptions, 'inboxStagingOffset' | 'inboxStagingCapacity'>,
): Vignette {
  const callExports: WasmCallExports = {
    vf_init: module._vf_init,
    vf_tick: module._vf_tick,
    vf_fixed_tick: module._vf_fixed_tick,
    vf_handle_message: module._vf_handle_message,
    vf_shutdown: module._vf_shutdown,
    vf_outbox_offset: module._vf_outbox_offset,
    vf_outbox_capacity: module._vf_outbox_capacity,
    vf_inbox_staging_offset: module._vf_inbox_staging_offset,
    vf_inbox_staging_capacity: module._vf_inbox_staging_capacity,
    vf_mem_alloc: module._vf_mem_alloc,
    vf_mem_free: module._vf_mem_free,
  };

  return new WasmVignette(
    () => module.HEAPU8,
    callExports,
    options?.inboxStagingOffset,
    options?.inboxStagingCapacity,
  );
}
