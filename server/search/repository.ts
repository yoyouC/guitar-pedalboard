import type {
  PublishedPresetSearchPage,
  RigDerivedAttributes,
  RigResourceDependencyKey,
} from '../../shared/marketplace.ts';

export interface PublishedPresetSearchInput {
  text: string;
  tagIds: string[];
  pedalIds: string[];
  ampIds: string[];
  cabIds: string[];
  resourceKinds: RigDerivedAttributes['resourceKinds'];
  resourceDependencyKeys: RigResourceDependencyKey[];
  publishedAfter: string | null;
  publishedBefore: string | null;
  limit: number;
  cursor: string | null;
}

export interface PublishedPresetSearchRepository {
  searchPublicPresets(input: PublishedPresetSearchInput): Promise<PublishedPresetSearchPage>;
}
