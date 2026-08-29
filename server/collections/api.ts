import type { SessionVerifier } from '../auth/session.ts';
import type { MemberRepository } from '../members/repository.ts';
import { communityWriteDenied } from '../members/communityWriteApi.ts';
import {
  PresetCollectionAccessError,
  PresetCollectionConflictError,
  PresetCollectionReferenceError,
  PresetCollectionTagError,
  type PresetCollectionManagementRepository,
  type PresetCollectionRepository,
} from './repository.ts';
import {
  validateCreatePresetCollection,
  validateUpdatePresetCollection,
} from '../../shared/collectionManagement.ts';

export interface PresetCollectionApi {
  fetch(request: Request): Promise<Response>;
}

const COLLECTION_PATH = /^\/api\/marketplace\/collections\/([^/]+)$/;
const COLLECTION_MANAGE_PATH = /^\/api\/marketplace\/collections\/([^/]+)\/manage$/;
const COLLECTIONS_PATH = '/api/marketplace/collections';

interface CollectionManagementDependencies {
  repository: PresetCollectionManagementRepository;
  sessions: SessionVerifier;
  members: MemberRepository;
  now(): Date;
  createCollectionId(): string;
  createMemberId(): string;
  createHandleSuffix(): string;
}

export function createPresetCollectionApi(input: {
  collections: PresetCollectionRepository;
  management?: CollectionManagementDependencies;
}): PresetCollectionApi {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const managementMatch = request.method === 'PATCH'
        ? COLLECTION_PATH.exec(url.pathname)
        : request.method === 'GET'
          ? COLLECTION_MANAGE_PATH.exec(url.pathname)
          : null;
      if (
        input.management
        && (
          (request.method === 'POST' && url.pathname === COLLECTIONS_PATH)
          || managementMatch
        )
      ) {
        try {
          const identity = await input.management.sessions.verify(request);
          if (!identity) {
            return Response.json(
              { error: { code: 'authentication_required', message: 'Authentication required' } },
              { status: 401 },
            );
          }
          const now = input.management.now();
          const member = await input.management.members.findOrCreateForIdentity({
            id: input.management.createMemberId(),
            identity,
            handle: `player-${input.management.createHandleSuffix()}`,
            now,
          });
          if (request.method !== 'GET') {
            const denied = communityWriteDenied(member);
            if (denied) return denied;
          }
          if (request.method === 'POST') {
            const tags = await input.management.repository.listAvailableTags();
            const validation = validateCreatePresetCollection(
              await jsonBody(request),
              new Set(tags.map((tag) => tag.id)),
            );
            if (!validation.value) return invalidCollection(validation.errors);
            const collection = await input.management.repository.create({
              id: input.management.createCollectionId(),
              creator: {
                id: member.id,
                handle: member.handle,
                displayName: member.displayName,
              },
              ...validation.value,
              now,
            });
            return Response.json({ collection }, { status: 201 });
          }
          const collectionId = decodeURIComponent(managementMatch![1]);
          if (request.method === 'GET') {
            const collection = await input.management.repository.findManagedById(
              collectionId,
              member.id,
            );
            return Response.json({ collection });
          }
          const tags = await input.management.repository.listAvailableTags();
          const validation = validateUpdatePresetCollection(
            await jsonBody(request),
            new Set(tags.map((tag) => tag.id)),
          );
          if (!validation.value) return invalidCollection(validation.errors);
          const collection = await input.management.repository.update({
            collectionId,
            creatorId: member.id,
            ...validation.value,
            expectedUpdatedAt: new Date(validation.value.expectedUpdatedAt),
            now,
          });
          return Response.json({ collection });
        } catch (cause) {
          if (cause instanceof PresetCollectionConflictError) {
            return Response.json({
              error: {
                code: 'collection_update_conflict',
                message: 'Collection changed since it was loaded',
                current: cause.current,
              },
            }, { status: 409 });
          }
          if (cause instanceof PresetCollectionAccessError) return collectionNotFound();
          if (cause instanceof PresetCollectionReferenceError) {
            return Response.json({
              error: {
                code: 'invalid_collection_reference',
                message: 'Collection includes an inaccessible preset revision',
              },
            }, { status: 400 });
          }
          if (cause instanceof PresetCollectionTagError) {
            return invalidCollection({ tagIds: '包含不可用标签' });
          }
          return marketplaceUnavailable();
        }
      }
      const match = request.method === 'GET' ? COLLECTION_PATH.exec(url.pathname) : null;
      if (!match) return new Response(null, { status: 404 });
      try {
        const collection = await input.collections.findVisibleById(decodeURIComponent(match[1]));
        if (!collection) {
          return collectionNotFound();
        }
        return Response.json({ collection });
      } catch {
        return marketplaceUnavailable();
      }
    },
  };
}

async function jsonBody(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

function invalidCollection(fields: Record<string, string>): Response {
  return Response.json({
    error: { code: 'invalid_collection', message: 'Preset collection is invalid', fields },
  }, { status: 400 });
}

function collectionNotFound(): Response {
  return Response.json({
    error: { code: 'preset_collection_not_found', message: 'Preset collection not found' },
  }, { status: 404 });
}

function marketplaceUnavailable(): Response {
  return Response.json({
    error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' },
  }, { status: 503 });
}
