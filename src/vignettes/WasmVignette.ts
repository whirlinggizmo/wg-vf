// Host-side loader that adapts a WASM module exporting the wg_vf.h ABI to the
// Vignette interface (§2.5). Drains the outbox ring buffer, stages inbound
// payloads, and reads the frame buffer. Works with an emscripten MODULARIZE
// module ({ HEAPU8, _vf_* }); createWasmInstance wraps it.
//
// A nonzero return from any vf_* export throws — the host treats it (and any
// WASM trap) as sim-fatal, since a trapped instance's memory is untrustworthy.

import {
  PeerLeftReason,
  SimFatalError,
  type FrameView,
  type OutboxEntry,
  type Vignette,
} from './Vignette.js';

type WasmExportFn = (...args: number[]) => number;

interface WasmCallExports {
  vf_init: WasmExportFn;
  vf_tick: WasmExportFn;
  vf_fixed_tick: WasmExportFn;
  vf_handle_message: WasmExportFn;
  vf_peer_joined: WasmExportFn;
  vf_peer_left: WasmExportFn;
  vf_shutdown: WasmExportFn;
  vf_outbox_offset: WasmExportFn;
  vf_outbox_capacity?: WasmExportFn;
  vf_frame_offset: WasmExportFn;
  vf_frame_len: WasmExportFn;
  vf_frame_seq: WasmExportFn;
  vf_mem_alloc: WasmExportFn;
  vf_mem_free?: WasmExportFn;
}

// The wg_vf ABI version this host understands (canonical source: ./abi.ts),
// re-exported here for back-compat. A wasm/native vignette reporting a different
// version — or none — is refused in createWasmInstance below.
export { WG_VF_ABI_VERSION } from './abi.js';
import { WG_VF_ABI_VERSION } from './abi.js';

/** The shape of an emscripten MODULARIZE module instance. */
export interface WasmVignetteInstance {
  HEAPU8: Uint8Array;
  _vf_abi_version?: WasmExportFn;
  _vf_init: WasmExportFn;
  _vf_tick: WasmExportFn;
  _vf_fixed_tick: WasmExportFn;
  _vf_handle_message: WasmExportFn;
  _vf_peer_joined: WasmExportFn;
  _vf_peer_left: WasmExportFn;
  _vf_shutdown: WasmExportFn;
  _vf_outbox_offset: WasmExportFn;
  _vf_outbox_capacity?: WasmExportFn;
  _vf_frame_offset: WasmExportFn;
  _vf_frame_len: WasmExportFn;
  _vf_frame_seq: WasmExportFn;
  _vf_mem_alloc: WasmExportFn;
  _vf_mem_free?: WasmExportFn;
}

type HeapU8Provider = () => Uint8Array;

const OUTBOX_HEADER_SIZE = 12; // head u32, tail u32, cap u32

class WasmVignette implements Vignette {
  // The wasm binary was already ABI-checked (vf_abi_version) in createWasmInstance;
  // expose the version so any Vignette reports it uniformly.
  readonly abiVersion = WG_VF_ABI_VERSION;

  private readonly outbox: OutboxEntry[] = [];
  // Once trapped, the instance's memory is untrustworthy — refuse all further
  // calls and keep every failure sim-fatal (§2.4).
  private trapped = false;

  constructor(
    private readonly getHeapU8: HeapU8Provider,
    private readonly exports: WasmCallExports,
  ) {}

  init(initPayload: Uint8Array): void {
    this.callWithPayload(this.exports.vf_init, 'vf_init', initPayload);
  }

  tick(dtUs: number, frameId: number): void {
    this.callSimple(this.exports.vf_tick, 'vf_tick', dtUs >>> 0, frameId >>> 0);
  }

  fixedTick(stepUs: number, stepIndex: number): void {
    this.callSimple(this.exports.vf_fixed_tick, 'vf_fixed_tick', stepUs >>> 0, stepIndex >>> 0);
  }

  handleMessage(senderId: number, payload: Uint8Array): void {
    this.callWithPayload(this.exports.vf_handle_message, 'vf_handle_message', payload, senderId >>> 0);
  }

  peerJoined(clientId: number): void {
    this.callSimple(this.exports.vf_peer_joined, 'vf_peer_joined', clientId >>> 0);
  }

  peerLeft(clientId: number, reason: PeerLeftReason): void {
    this.callSimple(this.exports.vf_peer_left, 'vf_peer_left', clientId >>> 0, reason >>> 0);
  }

  shutdown(): void {
    this.callSimple(this.exports.vf_shutdown, 'vf_shutdown');
  }

  outboxHasMessages(): boolean {
    return this.outbox.length > 0;
  }

  outboxPop(): OutboxEntry {
    const entry = this.outbox.shift();
    if (!entry) {
      throw new Error('WASM outbox is empty');
    }
    return entry;
  }

  currentFrame(): FrameView | null {
    const len = this.exports.vf_frame_len() >>> 0;
    if (len === 0) {
      return null;
    }
    const offset = this.exports.vf_frame_offset() >>> 0;
    const seq = this.exports.vf_frame_seq() >>> 0;
    return { seq, body: this.getHeapU8().slice(offset, offset + len) };
  }

  /** Invoke an export, converting any trap or nonzero return to SimFatalError. */
  private invoke(fn: WasmExportFn, name: string, args: number[]): void {
    if (this.trapped) {
      throw new SimFatalError(`WASM instance already trapped (before ${name})`);
    }
    let rc: number;
    try {
      rc = fn(...args) >>> 0;
    } catch (err) {
      // A WASM trap surfaces as a thrown RuntimeError — always sim-fatal.
      this.trapped = true;
      throw new SimFatalError(`WASM ${name} trapped: ${String(err)}`);
    }
    if (rc !== 0) {
      this.trapped = true;
      throw new SimFatalError(`WASM ${name} returned ${rc}`);
    }
  }

  private callSimple(fn: WasmExportFn, name: string, ...args: number[]): void {
    this.invoke(fn, name, args);
    this.drainOutboxRing();
  }

  /**
   * Stage `payload` into WASM memory, call `fn(...prefix, ptr, len)`, free.
   *
   * PAR-04: the staging layer needs no size cap of its own. The host already
   * rejects any inbound envelope over `maxPayloadBytes` at decode (ENV-08/25),
   * before delivery, so an oversized payload never reaches this point; what does
   * reach here is bounded, and a `vf_mem_alloc` that still fails is sim-fatal.
   */
  private callWithPayload(
    fn: WasmExportFn,
    name: string,
    payload: Uint8Array,
    ...prefix: number[]
  ): void {
    const ptr = this.exports.vf_mem_alloc(payload.length >>> 0) >>> 0;
    if (ptr === 0 && payload.length > 0) {
      throw new SimFatalError('WASM allocation failed');
    }
    this.getHeapU8().set(payload, ptr);
    try {
      this.invoke(fn, name, [...prefix, ptr, payload.length >>> 0]);
      this.drainOutboxRing();
    } finally {
      this.exports.vf_mem_free?.(ptr);
    }
  }

  private drainOutboxRing(): void {
    const base = this.exports.vf_outbox_offset() >>> 0;
    const view = this.memoryView();
    const cap = view.getUint32(base + 8, true) >>> 0;
    if (cap === 0) {
      return;
    }
    const payloadBase = base + OUTBOX_HEADER_SIZE;
    let head = view.getUint32(base, true) >>> 0;
    const tail = view.getUint32(base + 4, true) >>> 0;

    while (head !== tail) {
      // Entry: [payload_len u32][target_id u16][payload].
      const len = this.readRingU32(payloadBase, cap, head);
      const targetOffset = (head + 4) % cap;
      const target = this.readRingU16(payloadBase, cap, targetOffset);
      const payloadOffset = (targetOffset + 2) % cap;
      const payload = this.readRingBytes(payloadBase, cap, payloadOffset, len);
      this.outbox.push({ targetId: target, payload });
      head = (payloadOffset + len) % cap;
      view.setUint32(base, head >>> 0, true);
    }
  }

  private readRingU32(payloadBase: number, cap: number, offset: number): number {
    const b = this.readRingBytes(payloadBase, cap, offset, 4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) >>> 0;
  }

  private readRingU16(payloadBase: number, cap: number, offset: number): number {
    const b = this.readRingBytes(payloadBase, cap, offset, 2);
    return new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true);
  }

  private readRingBytes(payloadBase: number, cap: number, offset: number, len: number): Uint8Array {
    const heap = this.getHeapU8();
    const out = new Uint8Array(len >>> 0);
    if (len === 0) {
      return out;
    }
    const first = Math.min(len, cap - offset);
    out.set(heap.subarray(payloadBase + offset, payloadBase + offset + first), 0);
    if (first < len) {
      out.set(heap.subarray(payloadBase, payloadBase + (len - first)), first);
    }
    return out;
  }

  private memoryView(): DataView {
    const heap = this.getHeapU8();
    return new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
  }
}

/** Wrap an emscripten MODULARIZE module instance as a Vignette. */
export function createWasmInstance(module: WasmVignetteInstance): Vignette {
  // Refuse a vignette built against an incompatible ABI (§ versioning). A
  // missing export means it predates ABI versioning — also incompatible.
  const reported = typeof module._vf_abi_version === 'function' ? module._vf_abi_version() >>> 0 : 0;
  if (reported !== WG_VF_ABI_VERSION) {
    throw new Error(
      `wg-vf ABI mismatch: vignette reports ABI ${reported || 'unknown'}, host expects ${WG_VF_ABI_VERSION}. ` +
        `Rebuild the vignette against this version's wg_vf.h.`,
    );
  }

  const exports: WasmCallExports = {
    vf_init: module._vf_init,
    vf_tick: module._vf_tick,
    vf_fixed_tick: module._vf_fixed_tick,
    vf_handle_message: module._vf_handle_message,
    vf_peer_joined: module._vf_peer_joined,
    vf_peer_left: module._vf_peer_left,
    vf_shutdown: module._vf_shutdown,
    vf_outbox_offset: module._vf_outbox_offset,
    vf_outbox_capacity: module._vf_outbox_capacity,
    vf_frame_offset: module._vf_frame_offset,
    vf_frame_len: module._vf_frame_len,
    vf_frame_seq: module._vf_frame_seq,
    vf_mem_alloc: module._vf_mem_alloc,
    vf_mem_free: module._vf_mem_free,
  };
  return new WasmVignette(() => module.HEAPU8, exports);
}
