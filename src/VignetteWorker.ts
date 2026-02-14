import { WorkerVignetteHost } from './hosts/WorkerVignetteHost';
import { isWorkerVignetteType, type WorkerVignetteType } from './VignetteTypes';
import { createWasmInstance, type WasmVignetteInstance } from './WasmVignette';

type WorkerConfigMessage = {
  type: 'vf-config';
  vignetteType: WorkerVignetteType;
  vignetteUrl: string;
};

type WorkerMessage = WorkerConfigMessage | unknown;

function isWorkerConfigMessage(msg: unknown): msg is WorkerConfigMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }

  const candidate = msg as Partial<WorkerConfigMessage>;
  return (
    candidate.type === 'vf-config' &&
    isWorkerVignetteType(candidate.vignetteType) &&
    typeof candidate.vignetteUrl === 'string'
  );
}

function createHost(msg: WorkerConfigMessage): WorkerVignetteHost {
  if (msg.vignetteType === 'wasm') {
    return new WorkerVignetteHost({
      vignetteType: msg.vignetteType,
      vignetteFactory: async () => {
        if (typeof WorkerGlobalScope === 'undefined' && typeof self !== 'undefined') {
          (globalThis as Record<string, unknown>).WorkerGlobalScope = class WorkerGlobalScopeShim {};
        }

        const moduleFactory = (await import(/* @vite-ignore */ msg.vignetteUrl)).default as (
          opts?: {
            locateFile?: (path: string) => string;
          },
        ) => Promise<WasmVignetteInstance>;
        const wasmDirUrl = new URL('./', msg.vignetteUrl).href;
        const wasmModule = await moduleFactory({
          locateFile: (path: string) => new URL(path, wasmDirUrl).href,
        });
        return createWasmInstance(wasmModule);
      },
    });
  }

  return new WorkerVignetteHost({
    vignetteType: msg.vignetteType,
    vignetteModuleUrl: msg.vignetteUrl,
  });
}

let configured = false;

(self as DedicatedWorkerGlobalScope).onmessage = (event: MessageEvent<WorkerMessage>) => {
  if (configured) {
    return;
  }

  const msg = event.data;
  if (isWorkerConfigMessage(msg)) {
    configured = true;
    const host = createHost(msg);
    host.attachToWorker(self as DedicatedWorkerGlobalScope);
  }
};
