import type { PublicCreatorProfile, PublicCreatorWorkSummary } from '../../shared/members.ts';

interface CreatorProfileLoader {
  fetchCreator(handle: string): Promise<PublicCreatorProfile>;
  fetchWorks(handle: string): Promise<PublicCreatorWorkSummary[]>;
  onLoaded(creator: PublicCreatorProfile, works: PublicCreatorWorkSummary[]): void;
  onError(cause: unknown): void;
}

export function loadCreatorProfile(handle: string, loader: CreatorProfileLoader): () => void {
  let active = true;
  void Promise.all([loader.fetchCreator(handle), loader.fetchWorks(handle)])
    .then(([creator, works]) => {
      if (active) loader.onLoaded(creator, works);
    })
    .catch((cause: unknown) => {
      if (active) loader.onError(cause);
    });
  return () => {
    active = false;
  };
}
