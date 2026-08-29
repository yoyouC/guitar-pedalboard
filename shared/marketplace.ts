import {
  RIG_PRESET_VERSION,
  type RigPresetState,
} from '../src/state/presetCodec.ts';

export type PublishedPresetVisibility = 'public' | 'unlisted' | 'withdrawn' | 'hidden';

export interface MarketplaceMemberSummary {
  id: string;
  handle: string;
  displayName: string;
}

export interface MarketplaceTag {
  id: string;
  dimension: string;
  nameZh: string;
  nameEn: string;
}

export interface PublishedPresetSourceReference {
  presetId: string;
  revisionId: string;
}

export interface PublishedPresetSource extends PublishedPresetSourceReference {
  creator: MarketplaceMemberSummary;
  availability: 'available' | 'unavailable';
  title: string | null;
}

export type PresetCollectionVisibility = PublishedPresetVisibility;

export interface PresetCollectionItem {
  position: number;
  presetId: string;
  revisionId: string;
  availability: 'available' | 'unavailable';
  title: string | null;
  creator: MarketplaceMemberSummary;
}

export interface PresetCollection {
  id: string;
  title: string;
  description: string;
  visibility: PresetCollectionVisibility;
  creator: MarketplaceMemberSummary;
  tags: MarketplaceTag[];
  items: PresetCollectionItem[];
  createdAt: string;
  updatedAt: string;
}

export interface PresetCollectionReference {
  presetId: string;
  revisionId: string;
}

export interface CreatePresetCollectionRequest {
  title: string;
  description: string;
  tagIds: string[];
  visibility: 'public' | 'unlisted';
}

export interface UpdatePresetCollectionRequest
  extends Omit<CreatePresetCollectionRequest, 'visibility'> {
  visibility: 'public' | 'unlisted' | 'withdrawn';
  items: PresetCollectionReference[];
  expectedUpdatedAt: string;
}

export interface PresetCollectionConcurrencyState {
  updatedAt: string;
  visibility: PresetCollectionVisibility;
}

export interface PublishedPresetSearchItem {
  id: string;
  title: string;
  description: string;
  creator: MarketplaceMemberSummary;
  tags: MarketplaceTag[];
  derivedAttributes: RigDerivedAttributes;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedPresetSearchPage {
  items: PublishedPresetSearchItem[];
  nextCursor: string | null;
}

export type MarketplaceLikeTargetKind = 'preset' | 'collection';

export interface MarketplaceLikeState {
  liked: boolean;
  canLike: boolean;
  likeCount: number;
}

export interface MarketplaceLikeTargetSummary {
  id: string;
  title: string;
  creator: MarketplaceMemberSummary;
  likeCount: number;
}

export interface MarketplaceLikedTargetSummary extends MarketplaceLikeTargetSummary {
  likedAt: string;
}

export interface MarketplaceMyLikes {
  presets: MarketplaceLikedTargetSummary[];
  collections: MarketplaceLikedTargetSummary[];
}

export interface MarketplacePopularPage {
  items: MarketplaceLikeTargetSummary[];
  nextCursor: string | null;
}

export interface PublishedPresetSearchRequest {
  text?: string;
  tagIds?: string[];
  pedalIds?: string[];
  ampIds?: string[];
  cabIds?: string[];
  resourceKinds?: RigDerivedAttributes['resourceKinds'];
  resourceDependencyKeys?: RigResourceDependencyKey[];
  publishedAfter?: string;
  publishedBefore?: string;
  limit?: number;
  cursor?: string;
}

export type RigResourceDependency =
  | { kind: 'builtin' }
  | { kind: 'tone3000'; toneId: string; modelId?: string };

export type RigResourceDependencyKey = 'builtin' | `tone3000:${string}`;

export interface RigDerivedAttributes {
  pedalIds: string[];
  ampId: string;
  ampModelKey: string;
  cabId: string;
  resourceKinds: Array<RigResourceDependency['kind']>;
}

interface PublishedPresetRevisionBase<Rig> {
  id: string;
  schemaVersion: number;
  createdAt: string;
  resourceDependencies: RigResourceDependency[];
  derivedAttributes: RigDerivedAttributes;
  rig: Rig;
}

export interface CanonicalPublishedPresetRevision
  extends PublishedPresetRevisionBase<RigPresetState> {
  payloadKind: 'canonical-rig';
  schemaVersion: typeof RIG_PRESET_VERSION;
}

export interface OpaquePublishedPresetRevision
  extends PublishedPresetRevisionBase<unknown> {
  payloadKind: 'opaque';
}

export type PublishedPresetRevision =
  | CanonicalPublishedPresetRevision
  | OpaquePublishedPresetRevision;

export interface PublishedPreset<Revision extends PublishedPresetRevision = PublishedPresetRevision> {
  id: string;
  title: string;
  description: string;
  visibility: PublishedPresetVisibility;
  creator: MarketplaceMemberSummary;
  tags: MarketplaceTag[];
  derivedAttributes: RigDerivedAttributes;
  currentRevision: Revision;
  source?: PublishedPresetSource;
  createdAt: string;
  updatedAt: string;
}

export type CanonicalPublishedPreset = PublishedPreset<CanonicalPublishedPresetRevision>;

export interface PublishedPresetRevisionView {
  id: string;
  title: string;
  description: string;
  visibility: 'public' | 'unlisted';
  creator: MarketplaceMemberSummary;
  tags: MarketplaceTag[];
  revision: PublishedPresetRevision;
  currentRevisionId: string;
  source?: PublishedPresetSource;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedPresetRevisionSummary {
  id: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface PublishedPresetConcurrencyState {
  updatedAt: string;
  currentRevisionId: string;
  visibility: PublishedPresetVisibility;
}

export interface PublishPresetRequest {
  title: string;
  description: string;
  tagIds: string[];
  schemaVersion: number;
  rig: RigPresetState;
  source?: PublishedPresetSourceReference;
}

export interface UpdatePublishedPresetMetadataRequest {
  title: string;
  description: string;
  tagIds: string[];
  expectedUpdatedAt: string;
}

export interface AppendPublishedPresetRevisionRequest {
  schemaVersion: number;
  rig: RigPresetState;
  expectedUpdatedAt: string;
}

export interface RestorePublishedPresetRevisionRequest {
  expectedUpdatedAt: string;
}

export interface UpdatePublishedPresetVisibilityRequest {
  visibility: 'public' | 'unlisted' | 'withdrawn';
  expectedUpdatedAt: string;
}
