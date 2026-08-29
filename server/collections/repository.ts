import type {
  MarketplaceMemberSummary,
  PresetCollection,
  PresetCollectionConcurrencyState,
  PresetCollectionReference,
  PresetCollectionVisibility,
} from '../../shared/marketplace.ts';
import type {
  PublishedPresetRevisionReferenceRepository,
} from '../marketplace/repository.ts';

export interface PresetCollectionRepository {
  findVisibleById(id: string): Promise<PresetCollection | null>;
}

export class PresetCollectionAccessError extends Error {}
export class PresetCollectionReferenceError extends Error {}
export class PresetCollectionTagError extends Error {}

export class PresetCollectionConflictError extends Error {
  readonly current: PresetCollectionConcurrencyState;

  constructor(current: PresetCollectionConcurrencyState) {
    super('Preset collection changed since it was loaded');
    this.current = current;
  }
}

export interface CreatePresetCollectionInput {
  id: string;
  creator: MarketplaceMemberSummary;
  title: string;
  description: string;
  tagIds: string[];
  visibility: 'public' | 'unlisted';
  now: Date;
}

export interface UpdatePresetCollectionInput {
  collectionId: string;
  creatorId: string;
  title: string;
  description: string;
  tagIds: string[];
  visibility: 'public' | 'unlisted' | 'withdrawn';
  items: PresetCollectionReference[];
  expectedUpdatedAt: Date;
  now: Date;
}

export interface PresetCollectionManagementRepository extends PresetCollectionRepository {
  listAvailableTags(): Promise<import('../../shared/marketplace.ts').MarketplaceTag[]>;
  listManagedByCreator(creatorId: string): Promise<PresetCollection[]>;
  create(input: CreatePresetCollectionInput): Promise<PresetCollection>;
  findManagedById(collectionId: string, creatorId: string): Promise<PresetCollection>;
  update(input: UpdatePresetCollectionInput): Promise<PresetCollection>;
}

export interface PresetCollectionReferenceSource
  extends PublishedPresetRevisionReferenceRepository {}

export interface StoredPresetCollection {
  id: string;
  title: string;
  description: string;
  visibility: PresetCollectionVisibility;
  creator: MarketplaceMemberSummary;
  tagIds: string[];
  items: Array<{ presetId: string; revisionId: string }>;
  createdAt: string;
  updatedAt: string;
}
