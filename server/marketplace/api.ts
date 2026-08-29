import type { PublishedPresetRepository } from './repository.ts';
import type { PublishedPresetManagementRepository } from './repository.ts';
import {
  PublishedPresetAccessError,
  PublishedPresetConflictError,
  PublishedPresetRevisionNotFoundError,
  PublishedPresetSourceError,
  UnavailableTagError,
} from './repository.ts';
import {
  parseManagedPublishedPreset,
  parsePublicPublishedPreset,
  parsePublishedPresetRevisionView,
} from '../../shared/marketplaceValidation.ts';
import { validatePublishPresetRequest } from '../../shared/marketplacePublication.ts';
import {
  validateMetadataUpdate,
  validateRevisionAppend,
  validateRevisionRestore,
  validateVisibilityUpdate,
} from '../../shared/marketplaceManagement.ts';
import type { SessionVerifier } from '../auth/session.ts';
import type { MemberRepository } from '../members/repository.ts';
import { isReadyForPublicAttribution } from '../members/repository.ts';
import { CURRENT_MEMBER_TERMS_VERSION } from '../../shared/memberTerms.ts';
import { communityWriteDenied } from '../members/communityWriteApi.ts';
import type {
  RigResourceDependency,
  Tone3000DependencyFact,
} from '../../shared/marketplace.ts';
import { evaluatePublishedPresetRevisionCompatibility } from '../../shared/marketplaceCompatibility.ts';

export interface MarketplaceCompatibilityFacts {
  inspectTone3000Dependencies(
    dependencies: readonly RigResourceDependency[],
    request: Request,
  ): Promise<readonly Tone3000DependencyFact[]>;
}

export interface MarketplaceApiDependencies {
  publishedPresets: PublishedPresetRepository;
  availableTags?: PublishedPresetManagementRepository;
  compatibilityFacts?: MarketplaceCompatibilityFacts;
  publication?: {
    repository: PublishedPresetManagementRepository;
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
const PRESET_METADATA_PATH = /^\/api\/marketplace\/presets\/([^/]+)\/metadata$/;
const PRESET_MANAGE_PATH = /^\/api\/marketplace\/presets\/([^/]+)\/manage$/;
const PRESET_VISIBILITY_PATH = /^\/api\/marketplace\/presets\/([^/]+)\/visibility$/;
const PRESET_REVISIONS_PATH = /^\/api\/marketplace\/presets\/([^/]+)\/revisions$/;
const PRESET_REVISION_PATH = /^\/api\/marketplace\/presets\/([^/]+)\/revisions\/([^/]+)$/;
const PRESET_REVISION_COMPATIBILITY_PATH = /^\/api\/marketplace\/presets\/([^/]+)\/revisions\/([^/]+)\/compatibility$/;
const PRESET_REVISION_RESTORE_PATH = /^\/api\/marketplace\/presets\/([^/]+)\/revisions\/([^/]+)\/restore$/;
const PRESETS_PATH = '/api/marketplace/presets';
const MY_TONES_PATH = '/api/marketplace/me/tones';
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

function apiError(status: number, code: string, message: string, extra = {}): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

function invalidUpdate(fields: Record<string, string> = {}): Response {
  return apiError(400, 'invalid_preset_update', 'Published preset update is invalid', { fields });
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function createMarketplaceApi({
  publishedPresets,
  availableTags,
  compatibilityFacts,
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
          const denied = communityWriteDenied(member);
          if (denied) return denied;
          if (!isReadyForPublicAttribution(member, CURRENT_MEMBER_TERMS_VERSION)) {
            return apiError(409, 'public_profile_required', 'Complete your public profile first', {
              requiredTermsVersion: CURRENT_MEMBER_TERMS_VERSION,
            });
          }
          const created = await publication.repository.create({
            id: publication.createPresetId(),
            revisionId: publication.createRevisionId(),
            creator: {
              id: member.id,
              handle: member.handle,
              displayName: member.displayName,
            },
            ...validation.value.request,
            visibility: validation.value.request.visibility ?? 'public',
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
          if (cause instanceof PublishedPresetSourceError) {
            return Response.json(
              {
                error: {
                  code: 'invalid_publication',
                  message: 'Published preset is invalid',
                  fields: { source: '来源作品或修订无效' },
                },
              },
              { status: 400 },
            );
          }
          return marketplaceUnavailable();
        }
      }

      const compatibilityMatch = request.method === 'GET'
        ? PRESET_REVISION_COMPATIBILITY_PATH.exec(url.pathname)
        : null;
      if (compatibilityMatch) {
        const presetId = decodeURIComponent(compatibilityMatch[1]);
        const revisionId = decodeURIComponent(compatibilityMatch[2]);
        try {
          const view = await publishedPresets.findVisibleRevisionById(presetId, revisionId);
          if (!view) return publishedPresetNotFound();
          const parsed = parsePublishedPresetRevisionView(view, presetId, revisionId);
          if (!parsed) return marketplaceUnavailable();
          const facts = compatibilityFacts
            ? await compatibilityFacts.inspectTone3000Dependencies(
                parsed.revision.resourceDependencies,
                request,
              )
            : [];
          return Response.json({
            compatibility: evaluatePublishedPresetRevisionCompatibility(parsed.revision, facts),
          });
        } catch {
          return marketplaceUnavailable();
        }
      }

      const revisionMatch = request.method === 'GET'
        ? PRESET_REVISION_PATH.exec(url.pathname)
        : null;
      if (revisionMatch) {
        const presetId = decodeURIComponent(revisionMatch[1]);
        const revisionId = decodeURIComponent(revisionMatch[2]);
        try {
          const view = await publishedPresets.findVisibleRevisionById(presetId, revisionId);
          if (!view) return publishedPresetNotFound();
          const parsed = parsePublishedPresetRevisionView(view, presetId, revisionId);
          return parsed ? Response.json({ preset: parsed }) : marketplaceUnavailable();
        } catch {
          return marketplaceUnavailable();
        }
      }

      if (publication) {
        if (request.method === 'GET' && url.pathname === MY_TONES_PATH) {
          try {
            const identity = await publication.sessions.verify(request);
            if (!identity) return apiError(401, 'authentication_required', 'Authentication required');
            const member = await publication.members.findOrCreateForIdentity({
              id: publication.createMemberId(), identity,
              handle: `player-${publication.createHandleSuffix()}`, now: publication.now(),
            });
            const tones = await publication.repository.listManagedByCreator(member.id);
            const parsed = tones.map((tone) => parseManagedPublishedPreset(tone, tone.id));
            return parsed.every(Boolean) ? Response.json({ tones: parsed }) : marketplaceUnavailable();
          } catch { return marketplaceUnavailable(); }
        }
        const metadataMatch = request.method === 'PATCH'
          ? PRESET_METADATA_PATH.exec(url.pathname)
          : null;
        const visibilityMatch = request.method === 'PATCH'
          ? PRESET_VISIBILITY_PATH.exec(url.pathname)
          : null;
        const revisionsMatch = PRESET_REVISIONS_PATH.exec(url.pathname);
        const manageMatch = request.method === 'GET' ? PRESET_MANAGE_PATH.exec(url.pathname) : null;
        const restoreMatch = request.method === 'POST'
          ? PRESET_REVISION_RESTORE_PATH.exec(url.pathname)
          : null;
        const managementMatch = metadataMatch ?? visibilityMatch ?? revisionsMatch ?? restoreMatch ?? manageMatch;

        if (managementMatch) {
          try {
            const identity = await publication.sessions.verify(request);
            if (!identity) return apiError(401, 'authentication_required', 'Authentication required');
            const now = publication.now();
            const member = await publication.members.findOrCreateForIdentity({
              id: publication.createMemberId(),
              identity,
              handle: `player-${publication.createHandleSuffix()}`,
              now,
            });
            if (request.method !== 'GET') {
              const denied = communityWriteDenied(member);
              if (denied) return denied;
            }
            const presetId = decodeURIComponent(managementMatch[1]);

            if (manageMatch) {
              const preset = await publication.repository.findManagedById(presetId, member.id);
              const parsed = parseManagedPublishedPreset(preset, presetId);
              return parsed ? Response.json({ preset: parsed }) : marketplaceUnavailable();
            }

            if (revisionsMatch && request.method === 'GET') {
              return Response.json({
                revisions: await publication.repository.listRevisions(presetId, member.id),
              });
            }
            if (revisionsMatch && request.method === 'POST') {
              const validation = validateRevisionAppend(await jsonBody(request));
              if (!validation.value) return invalidUpdate(validation.errors);
              const updated = await publication.repository.appendRevision({
                presetId,
                creatorId: member.id,
                revisionId: publication.createRevisionId(),
                schemaVersion: validation.value.request.schemaVersion,
                rig: validation.value.request.rig,
                resourceDependencies: validation.value.resourceDependencies,
                derivedAttributes: validation.value.derivedAttributes,
                expectedUpdatedAt: new Date(validation.value.request.expectedUpdatedAt),
                now,
              });
              const parsed = parseManagedPublishedPreset(updated, presetId);
              return parsed
                ? Response.json({ preset: parsed }, { status: 201 })
                : marketplaceUnavailable();
            }
            if (metadataMatch) {
              const tags = await publication.repository.listAvailableTags();
              const validation = validateMetadataUpdate(
                await jsonBody(request),
                new Set(tags.map((tag) => tag.id)),
              );
              if (!validation.value) return invalidUpdate(validation.errors);
              const updated = await publication.repository.updateMetadata({
                presetId,
                creatorId: member.id,
                ...validation.value,
                expectedUpdatedAt: new Date(validation.value.expectedUpdatedAt),
                now,
              });
              const parsed = parseManagedPublishedPreset(updated, presetId);
              return parsed ? Response.json({ preset: parsed }) : marketplaceUnavailable();
            }
            if (visibilityMatch) {
              const update = validateVisibilityUpdate(await jsonBody(request));
              if (!update) return invalidUpdate();
              const updated = await publication.repository.updateVisibility({
                presetId,
                creatorId: member.id,
                visibility: update.visibility,
                expectedUpdatedAt: new Date(update.expectedUpdatedAt),
                now,
              });
              const parsed = parseManagedPublishedPreset(updated, presetId);
              return parsed ? Response.json({ preset: parsed }) : marketplaceUnavailable();
            }
            if (restoreMatch) {
              const update = validateRevisionRestore(await jsonBody(request));
              if (!update) return invalidUpdate();
              const updated = await publication.repository.restoreRevision({
                presetId,
                creatorId: member.id,
                sourceRevisionId: decodeURIComponent(restoreMatch[2]),
                revisionId: publication.createRevisionId(),
                expectedUpdatedAt: new Date(update.expectedUpdatedAt),
                now,
              });
              const parsed = parseManagedPublishedPreset(updated, presetId);
              return parsed
                ? Response.json({ preset: parsed }, { status: 201 })
                : marketplaceUnavailable();
            }
          } catch (cause) {
            if (cause instanceof PublishedPresetConflictError) {
              return apiError(409, 'preset_update_conflict', 'Preset changed since it was loaded', {
                current: cause.current,
              });
            }
            if (
              cause instanceof PublishedPresetAccessError
              || cause instanceof PublishedPresetRevisionNotFoundError
            ) return publishedPresetNotFound();
            if (cause instanceof UnavailableTagError) {
              return invalidUpdate({ tagIds: '包含不可用标签' });
            }
            return marketplaceUnavailable();
          }
        }
      }

      const match = request.method === 'GET' ? PUBLIC_PRESET_PATH.exec(url.pathname) : null;
      if (!match) return publishedPresetNotFound();

      let preset;
      try {
        preset = await publishedPresets.findVisibleById(decodeURIComponent(match[1]));
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
