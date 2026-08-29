import type {
  MarketplaceMemberSummary,
  MarketplaceTag,
  PublishedPreset,
  PublishedPresetConcurrencyState,
  PublishedPresetRevisionSummary,
  PublishedPresetRevisionView,
  PublishedPresetVisibility,
  RigDerivedAttributes,
  RigResourceDependency,
} from '../../shared/marketplace.ts';
import {
  RIG_PRESET_VERSION,
  type RigPresetState,
} from '../../src/state/presetCodec.ts';

export interface PublishedPresetRepository {
  findVisibleById(id: string): Promise<PublishedPreset | null>;
  findVisibleRevisionById(
    presetId: string,
    revisionId: string,
  ): Promise<PublishedPresetRevisionView | null>;
}

export interface CreatePublishedPresetInput {
  id: string;
  revisionId: string;
  creator: MarketplaceMemberSummary;
  title: string;
  description: string;
  tagIds: string[];
  schemaVersion: typeof RIG_PRESET_VERSION;
  rig: RigPresetState;
  resourceDependencies: RigResourceDependency[];
  derivedAttributes: RigDerivedAttributes;
  now: Date;
}

export class UnavailableTagError extends Error {}

export class PublishedPresetAccessError extends Error {}

export class PublishedPresetRevisionNotFoundError extends Error {}

export class PublishedPresetConflictError extends Error {
  readonly current: PublishedPresetConcurrencyState;

  constructor(current: PublishedPresetConcurrencyState) {
    super('Published preset changed since it was loaded');
    this.current = current;
  }
}

interface OwnedPresetMutationInput {
  presetId: string;
  creatorId: string;
  expectedUpdatedAt: Date;
  now: Date;
}

export interface UpdatePublishedPresetMetadataInput extends OwnedPresetMutationInput {
  title: string;
  description: string;
  tagIds: string[];
}

export interface AppendPublishedPresetRevisionInput extends OwnedPresetMutationInput {
  revisionId: string;
  schemaVersion: typeof RIG_PRESET_VERSION;
  rig: RigPresetState;
  resourceDependencies: RigResourceDependency[];
  derivedAttributes: RigDerivedAttributes;
}

export interface RestorePublishedPresetRevisionInput extends OwnedPresetMutationInput {
  sourceRevisionId: string;
  revisionId: string;
}

export interface UpdatePublishedPresetVisibilityInput extends OwnedPresetMutationInput {
  visibility: Exclude<PublishedPresetVisibility, 'hidden'>;
}

export interface PublishedPresetPublicationRepository {
  listAvailableTags(): Promise<MarketplaceTag[]>;
  create(input: CreatePublishedPresetInput): Promise<PublishedPreset>;
}

export interface PublishedPresetManagementRepository
  extends PublishedPresetPublicationRepository {
  findManagedById(presetId: string, creatorId: string): Promise<PublishedPreset>;
  listRevisions(presetId: string, creatorId: string): Promise<PublishedPresetRevisionSummary[]>;
  updateMetadata(input: UpdatePublishedPresetMetadataInput): Promise<PublishedPreset>;
  appendRevision(input: AppendPublishedPresetRevisionInput): Promise<PublishedPreset>;
  restoreRevision(input: RestorePublishedPresetRevisionInput): Promise<PublishedPreset>;
  updateVisibility(input: UpdatePublishedPresetVisibilityInput): Promise<PublishedPreset>;
}
