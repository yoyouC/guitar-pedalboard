import type {
  MarketplaceMemberSummary,
  MarketplaceTag,
  PublishedPreset,
  RigDerivedAttributes,
  RigResourceDependency,
} from '../../shared/marketplace.ts';
import type { RigPresetState } from '../../src/state/presetCodec.ts';

export interface PublishedPresetRepository {
  findPublicById(id: string): Promise<PublishedPreset | null>;
}

export interface CreatePublishedPresetInput {
  id: string;
  revisionId: string;
  creator: MarketplaceMemberSummary;
  title: string;
  description: string;
  tagIds: string[];
  schemaVersion: number;
  rig: RigPresetState;
  resourceDependencies: RigResourceDependency[];
  derivedAttributes: RigDerivedAttributes;
  now: Date;
}

export class UnavailableTagError extends Error {}

export interface PublishedPresetPublicationRepository {
  listAvailableTags(): Promise<MarketplaceTag[]>;
  create(input: CreatePublishedPresetInput): Promise<PublishedPreset>;
}
