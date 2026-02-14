export type WorkerVignetteType = 'js' | 'wasm';
export type RemoteVignetteType = 'js' | 'wasm' | 'native';
export type VignetteType = RemoteVignetteType;

export function isWorkerVignetteType(value: unknown): value is WorkerVignetteType {
  return value === 'js' || value === 'wasm';
}

export function isRemoteVignetteType(value: unknown): value is RemoteVignetteType {
  return value === 'js' || value === 'wasm' || value === 'native';
}
