import type {
  MarketplaceSearchPage,
  PresetCollectionSearchItem,
  PublicCreatorSearchItem,
  PublishedPresetSearchPage,
  RigDerivedAttributes,
  RigResourceDependencyKey,
} from '../../shared/marketplace.js';

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

export interface MarketplaceDiscoverySearchInput {
  text: string;
  limit: number;
  cursor: string | null;
}

export interface MarketplaceDiscoveryRepository {
  searchPublicCollections(
    input: MarketplaceDiscoverySearchInput,
  ): Promise<MarketplaceSearchPage<PresetCollectionSearchItem>>;
  searchCreators(
    input: MarketplaceDiscoverySearchInput,
  ): Promise<MarketplaceSearchPage<PublicCreatorSearchItem>>;
}
