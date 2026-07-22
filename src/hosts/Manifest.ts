// The manifest: how a host resolves a named vignette to code (Part I §3.1–§3.2,
// Part II §4). A peer names a vignette by id; the host looks the id up here and
// loads it. Two entry forms:
//   - code form  { create }            — an in-process factory (tests, bundled apps)
//   - module form { type, module }     — a URL the host imports and wraps
// The framework owns the loading (loadVignetteModule); apps only declare intent.

import type { Vignette } from '../vignettes/Vignette.js';

export interface VignetteConfig {
  version: string;
  fixedStepUs: number;
  maxSubsteps: number;
  maxPeers: number;
  reconnectGraceMs?: number;
  emptyGraceMs?: number;
  maxPayloadBytes?: number;
}

/** In-process factory (code form). */
export interface FactorySource {
  create: () => Vignette | Promise<Vignette>;
}

/** A module URL the host imports and wraps (module form). */
export interface ModuleSource {
  type: 'js' | 'wasm';
  /** URL/specifier of the built vignette module. */
  module: string;
}

export type VignetteSource = FactorySource | ModuleSource;
export type ManifestEntry = VignetteConfig & VignetteSource;

export interface Manifest {
  vignettes: Record<string, ManifestEntry>;
}

export function isModuleSource(entry: VignetteSource): entry is ModuleSource {
  return 'module' in entry;
}

/** Convenience: a single-vignette manifest. */
export function singleVignetteManifest(id: string, entry: ManifestEntry): Manifest {
  return { vignettes: { [id]: entry } };
}
