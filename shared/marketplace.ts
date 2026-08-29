import type { RigPresetState } from '../src/state/presetCodec.ts';

export type PublishedPresetVisibility = 'public' | 'unlisted' | 'withdrawn' | 'hidden';

export interface MarketplaceMemberSummary {
  id: string;
  handle: string;
  displayName: string;
}

export type RigResourceDependency =
  | { kind: 'builtin' }
  | { kind: 'tone3000'; toneId: string; modelId?: string };

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
  currentRevision: PublishedPresetRevision;
  createdAt: string;
  updatedAt: string;
}
