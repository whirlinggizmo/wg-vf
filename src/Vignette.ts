import { createWasmInstance, type WasmVignetteInstance } from './WasmVignette';

export type VignetteType = 'js' | 'wasm';

export function isVignetteType(value: unknown): value is VignetteType {
  return value === 'js' || value === 'wasm';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Vignette {
  init(initPayload: Uint8Array): Promise<void>;
  tick(dtUs: number, frameId: number): Promise<void>;
  fixedTick(stepUs: number, stepIndex: number): Promise<void>;
  handleMessage(payload: Uint8Array): Promise<void>;
  shutdown(): Promise<void>;
  outboxHasMessages(): boolean;
  outboxPop(): Uint8Array;
}

export async function instantiateVignetteFromModuleUrl(
  vignetteType: VignetteType,
  vignetteUrl: string,
): Promise<Vignette> {
  if (vignetteType === 'wasm') {
    if (typeof WorkerGlobalScope === 'undefined' && typeof self !== 'undefined') {
      (globalThis as Record<string, unknown>).WorkerGlobalScope = class WorkerGlobalScopeShim {};
    }

    const moduleFactory = (await import(/* @vite-ignore */ vignetteUrl)).default as (opts?: {
      locateFile?: (path: string) => string;
    }) => Promise<WasmVignetteInstance>;

    if (typeof moduleFactory !== 'function') {
      throw new Error('WASM vignette module must default-export an Emscripten module factory');
    }

    const wasmDirUrl = new URL('./', vignetteUrl).href;
    const wasmModule = await moduleFactory({
      locateFile: (path: string) => new URL(path, wasmDirUrl).href,
    });
    return createWasmInstance(wasmModule);
  }

  const mod = await import(/* @vite-ignore */ vignetteUrl);

  if (typeof mod.createVignette === 'function') {
    return await mod.createVignette();
  }

  if (typeof mod.default === 'function') {
    return new mod.default();
  }

  throw new Error('Vignette module must export createVignette() or a default class');
}

export abstract class BaseVignette implements Vignette {
  private readonly outbox: Uint8Array[] = [];

  abstract init(initPayload: Uint8Array): Promise<void>;
  abstract tick(dtUs: number, frameId: number): Promise<void>;
  abstract fixedTick(stepUs: number, stepIndex: number): Promise<void>;
  abstract handleMessage(payload: Uint8Array): Promise<void>;
  abstract shutdown(): Promise<void>;

  outboxHasMessages(): boolean {
    return this.outbox.length > 0;
  }

  outboxPop(): Uint8Array {
    if (this.outbox.length === 0) {
      console.warn(`[${this.constructor.name}] outboxPop called with empty outbox`);
      return new Uint8Array();
    }
    return this.outbox.shift() as Uint8Array;
  }

  protected pushOutboxBytes(payload: Uint8Array): void {
    this.outbox.push(payload);
  }

  protected pushOutboxJson(payload: unknown): void {
    this.outbox.push(encoder.encode(JSON.stringify(payload)));
  }

  protected parseJson<T>(bytes: Uint8Array): T | null {
    try {
      return JSON.parse(decoder.decode(bytes)) as T;
    } catch {
      return null;
    }
  }

  protected clearOutbox(): void {
    this.outbox.length = 0;
  }
}
