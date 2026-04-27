import { type Vignette, type VignetteType, isVignetteType } from '../vignettes/Vignette';
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
    const fallback = {
      vignetteType: this.defaultVignetteType,
      vignetteUrl: this.defaultVignetteUrl,
      vignetteInitPayload: initPayload,
    };

    try {
      const parsed = JSON.parse(new TextDecoder().decode(initPayload)) as {
        vignetteType?: unknown;
        vignetteUrl?: unknown;
        initPayload?: unknown;
      };

      const vignetteType = isVignetteType(parsed?.vignetteType)
        ? parsed.vignetteType
        : this.defaultVignetteType;
      const vignetteUrl =
        typeof parsed?.vignetteUrl === 'string' ? parsed.vignetteUrl : this.defaultVignetteUrl;
      const vignetteInitPayload =
        parsed && Object.prototype.hasOwnProperty.call(parsed, 'initPayload')
          ? new TextEncoder().encode(JSON.stringify(parsed.initPayload))
          : initPayload;

      return {
        vignetteType,
        vignetteUrl,
        vignetteInitPayload,
      };
    } catch {
      return fallback;
    }
  }
}
