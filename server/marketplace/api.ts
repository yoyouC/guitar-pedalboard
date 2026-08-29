import type { PublishedPresetRepository } from './repository.ts';
import { parsePublicPublishedPreset } from '../../shared/marketplaceValidation.ts';

export interface MarketplaceApiDependencies {
  publishedPresets: PublishedPresetRepository;
}

export interface MarketplaceApi {
  fetch(request: Request): Promise<Response>;
}

const PUBLIC_PRESET_PATH = /^\/api\/marketplace\/presets\/([^/]+)$/;

function publishedPresetNotFound(): Response {
  return Response.json(
    {
      error: {
        code: 'published_preset_not_found',
        message: 'Published preset not found',
      },
    },
    { status: 404 },
  );
}

function marketplaceUnavailable(): Response {
  return Response.json(
    {
      error: {
        code: 'marketplace_unavailable',
        message: 'Marketplace is temporarily unavailable',
      },
    },
    { status: 503 },
  );
}

export function createMarketplaceApi({
  publishedPresets,
}: MarketplaceApiDependencies): MarketplaceApi {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const match = request.method === 'GET' ? PUBLIC_PRESET_PATH.exec(url.pathname) : null;
      if (!match) return publishedPresetNotFound();

      let preset;
      try {
        preset = await publishedPresets.findPublicById(decodeURIComponent(match[1]));
      } catch {
        return marketplaceUnavailable();
      }
      if (!preset) return publishedPresetNotFound();

      const parsedPreset = parsePublicPublishedPreset(preset, decodeURIComponent(match[1]));
      if (!parsedPreset) return marketplaceUnavailable();

      return Response.json({ preset: parsedPreset });
    },
  };
}
