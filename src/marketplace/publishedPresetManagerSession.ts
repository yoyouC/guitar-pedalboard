import type {
  MarketplaceTag,
  PublishedPreset,
  PublishedPresetRevisionSummary,
} from '../../shared/marketplace';

export interface PublishedPresetManagerData {
  tags: MarketplaceTag[];
  revisions: PublishedPresetRevisionSummary[];
}

interface PublishedPresetManagerDataSource {
  listAvailableTags(): Promise<MarketplaceTag[]>;
  listPublishedPresetRevisions(presetId: string): Promise<PublishedPresetRevisionSummary[]>;
}

interface ManagerDataCallbacks {
  onLoaded(data: PublishedPresetManagerData): void;
  onError(cause: unknown): void;
}

async function readManagerData(
  presetId: string,
  source: PublishedPresetManagerDataSource,
): Promise<PublishedPresetManagerData> {
  const [tags, revisions] = await Promise.all([
    source.listAvailableTags(),
    source.listPublishedPresetRevisions(presetId),
  ]);
  return { tags, revisions };
}

export function loadPublishedPresetManagerData(
  presetId: string,
  source: PublishedPresetManagerDataSource,
  callbacks: ManagerDataCallbacks,
): () => void {
  let active = true;
  void readManagerData(presetId, source).then(
    (data) => {
      if (active) callbacks.onLoaded(data);
    },
    (cause: unknown) => {
      if (active) callbacks.onError(cause);
    },
  );
  return () => { active = false; };
}

interface ManagerMutationCallbacks extends ManagerDataCallbacks {
  onUpdated(preset: PublishedPreset): void;
}

export function runPublishedPresetManagerMutation(
  presetId: string,
  source: PublishedPresetManagerDataSource,
  operation: () => Promise<PublishedPreset>,
  callbacks: ManagerMutationCallbacks,
): () => void {
  let active = true;
  void operation()
    .then(async (preset) => {
      if (!active) return;
      callbacks.onUpdated(preset);
      const data = await readManagerData(presetId, source);
      if (active) callbacks.onLoaded(data);
    })
    .catch((cause: unknown) => {
      if (active) callbacks.onError(cause);
    });
  return () => { active = false; };
}
