import type { RigPresetState } from '../src/state/presetCodec.ts';

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

export interface PublishedPresetRevision {
  id: string;
  schemaVersion: number;
  createdAt: string;
  resourceDependencies: RigResourceDependency[];
  rig: RigPresetState;
}

export interface PublishedPreset {
  id: string;
  title: string;
  description: string;
  visibility: PublishedPresetVisibility;
  creator: MarketplaceMemberSummary;
  tags: MarketplaceTag[];
  derivedAttributes: RigDerivedAttributes;
  currentRevision: PublishedPresetRevision;
  createdAt: string;
  updatedAt: string;
}

export interface PublishPresetRequest {
  title: string;
  description: string;
  tagIds: string[];
  schemaVersion: number;
  rig: RigPresetState;
}
