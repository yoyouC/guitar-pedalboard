import type { RigPresetState, RigProvenance } from '../state/presetCodec';

const KEY = 'guitar-pedalboard:publish-draft:v1';

export type PublicationKind = 'new-work' | 'new-revision' | 'remix';

export interface PublishDraft {
  version: 1;
  rig: RigPresetState;
  provenance: RigProvenance | null;
  title: string;
  description: string;
  tagIds: string[];
  visibility: 'public' | 'unlisted' | null;
  createdAt: string;
}

function storage(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

export function publicationKind(provenance: RigProvenance | null, memberId: string): PublicationKind {
  return !provenance ? 'new-work' : provenance.creatorId === memberId ? 'new-revision' : 'remix';
}

export function createPublishDraft(rig: RigPresetState, provenance: RigProvenance | null): PublishDraft {
  const draft: PublishDraft = {
    version: 1,
    rig,
    provenance,
    title: '',
    description: '',
    tagIds: [],
    visibility: null,
    createdAt: new Date().toISOString(),
  };
  storage()?.setItem(KEY, JSON.stringify(draft));
  return draft;
}

export function loadPublishDraft(): PublishDraft | null {
  try {
    const value = JSON.parse(storage()?.getItem(KEY) ?? 'null') as PublishDraft | null;
    return value?.version === 1 && value.rig && Array.isArray(value.tagIds) ? value : null;
  } catch { return null; }
}

export function savePublishDraft(draft: PublishDraft): void {
  try { storage()?.setItem(KEY, JSON.stringify(draft)); } catch { /* keep in component memory */ }
}

export function clearPublishDraft(): void {
  try { storage()?.removeItem(KEY); } catch { /* no persistent draft to clear */ }
}
