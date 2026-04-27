import type { Vignette, VignetteType } from '../vignettes/Vignette';
import { decodeInitPayload } from '../envelope/systemPayloads';
import { BaseVignetteHost, type ResolvedInitPayload } from './BaseVignetteHost';

interface LocalVignetteHostOptions {
  vignetteFactory?: () => Vignette | Promise<Vignette>;
  vignetteUrl?: string;
  vignetteType?: VignetteType;
  fixedStepUs?: number;
  maxSubsteps?: number;
}

export class LocalVignetteHost extends BaseVignetteHost {
  private readonly defaultVignetteUrl?: string;
  private readonly defaultVignetteType: VignetteType;

  constructor(options: LocalVignetteHostOptions) {
    super({
      vignetteFactory: options.vignetteFactory,
      fixedStepUs: options.fixedStepUs,
      maxSubsteps: options.maxSubsteps,
      initialVignetteType: options.vignetteType ?? 'js',
    });
    this.defaultVignetteUrl = options.vignetteUrl;
    this.defaultVignetteType = options.vignetteType ?? 'js';
  }

  protected resolveInitPayload(initPayload: Uint8Array): ResolvedInitPayload {
    // Try to parse as binary Init payload first (for authority override)
    const parsed = decodeInitPayload(initPayload);
    if (parsed !== null) {
      return {
        vignetteType: parsed.vignetteType,
        vignetteUrl: parsed.vignetteUrl,
        vignetteInitPayload: parsed.initPayload,
      };
    }

    // Fall back to connect-time defaults (opaque app payload)
    return {
      vignetteType: this.defaultVignetteType,
      vignetteUrl: this.defaultVignetteUrl,
      vignetteInitPayload: initPayload,
    };
  }
}
