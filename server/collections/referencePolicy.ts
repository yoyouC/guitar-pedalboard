import type {
  PresetCollectionVisibility,
  PublishedPresetVisibility,
} from '../../shared/marketplace.js';

export function canIncludePresetRevision(input: {
  targetVisibility: 'public' | 'unlisted' | 'withdrawn';
  currentVisibility: PresetCollectionVisibility;
  collectionCreatorId: string;
  presetVisibility: PublishedPresetVisibility;
  presetCreatorId: string;
  alreadyIncluded: boolean;
}): boolean {
  if (input.presetVisibility === 'public') return true;
  if (
    input.targetVisibility === 'unlisted'
    && input.presetVisibility === 'unlisted'
    && input.presetCreatorId === input.collectionCreatorId
  ) return true;
  return input.alreadyIncluded && (
    input.presetVisibility === 'withdrawn'
    || input.presetVisibility === 'hidden'
    || input.targetVisibility === input.currentVisibility
    || input.targetVisibility === 'withdrawn'
  );
}
