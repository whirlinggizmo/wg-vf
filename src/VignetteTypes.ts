export type VignetteType = 'js' | 'wasm';

export function isVignetteType(value: unknown): value is VignetteType {
  return value === 'js' || value === 'wasm';
}
