import type { PublishedPresetRepository } from './repository.ts';
import type { PublishedPresetPublicationRepository } from './repository.ts';
import { UnavailableTagError } from './repository.ts';
import { parsePublicPublishedPreset } from '../../shared/marketplaceValidation.ts';
import { validatePublishPresetRequest } from '../../shared/marketplacePublication.ts';
import type { SessionVerifier } from '../auth/session.ts';
import type { MemberRepository } from '../members/repository.ts';

export interface MarketplaceApiDependencies {
  publishedPresets: PublishedPresetRepository;
  availableTags?: PublishedPresetPublicationRepository;
  publication?: {
    repository: PublishedPresetPublicationRepository;
    sessions: SessionVerifier;
    members: MemberRepository;
    now(): Date;
    createPresetId(): string;
    createRevisionId(): string;
    createMemberId(): string;
    createHandleSuffix(): string;
  };
}

export interface MarketplaceApi {
  fetch(request: Request): Promise<Response>;
}

const PUBLIC_PRESET_PATH = /^\/api\/marketplace\/presets\/([^/]+)$/;
const PRESETS_PATH = '/api/marketplace/presets';
const TAGS_PATH = '/api/marketplace/tags';

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
  availableTags,
  publication,
}: MarketplaceApiDependencies): MarketplaceApi {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === TAGS_PATH && (availableTags || publication)) {
        try {
          const repository = availableTags ?? publication?.repository;
          return Response.json({ tags: await repository?.listAvailableTags() ?? [] });
        } catch {
          return marketplaceUnavailable();
        }
      }

      if (request.method === 'POST' && url.pathname === PRESETS_PATH && publication) {
        try {
          const identity = await publication.sessions.verify(request);
          if (!identity) {
            return Response.json(
              { error: { code: 'authentication_required', message: 'Authentication required' } },
              { status: 401 },
            );
          }
          const tags = await publication.repository.listAvailableTags();
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            body = null;
          }
          const validation = validatePublishPresetRequest(body, new Set(tags.map((tag) => tag.id)));
          if (!validation.value) {
            return Response.json(
              {
                error: {
                  code: 'invalid_publication',
                  message: 'Published preset is invalid',
                  fields: validation.errors,
                },
              },
              { status: 400 },
            );
          }
          const now = publication.now();
          const member = await publication.members.findOrCreateForIdentity({
            id: publication.createMemberId(),
            identity,
            handle: `player-${publication.createHandleSuffix()}`,
            now,
          });
          const created = await publication.repository.create({
            id: publication.createPresetId(),
            revisionId: publication.createRevisionId(),
            creator: {
              id: member.id,
              handle: member.handle,
              displayName: member.displayName,
            },
            ...validation.value.request,
            resourceDependencies: validation.value.resourceDependencies,
            derivedAttributes: validation.value.derivedAttributes,
            now,
          });
          const parsed = parsePublicPublishedPreset(created, created.id);
          return parsed
            ? Response.json({ preset: parsed }, { status: 201 })
            : marketplaceUnavailable();
        } catch (cause) {
          if (cause instanceof UnavailableTagError) {
            return Response.json(
              {
                error: {
                  code: 'invalid_publication',
                  message: 'Published preset is invalid',
                  fields: { tagIds: '包含不可用标签' },
                },
              },
              { status: 400 },
            );
          }
          return marketplaceUnavailable();
        }
      }

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
