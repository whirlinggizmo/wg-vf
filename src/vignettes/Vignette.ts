import { createWasmInstance, type WasmVignetteInstance } from './WasmVignette.js';

export type VignetteType = 'js' | 'wasm';

export function isVignetteType(value: unknown): value is VignetteType {
  return value === 'js' || value === 'wasm';
}

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
