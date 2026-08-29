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

export type RigResourceDependency =
  | { kind: 'builtin' }
  | { kind: 'tone3000'; toneId: string; modelId?: string };

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
