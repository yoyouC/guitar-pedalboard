import type {
  PresetCollection,
  PresetCollectionItem,
  PublishedPresetRevisionView,
} from '../../shared/marketplace';
import type { LoadPresetResult } from '../state/rigStore';
import type { ApplicablePublishedPreset } from './applyPublishedPreset';

const SESSION_KEY = 'guitar-pedalboard:collection-queue:v1';

export interface CollectionQueueState {
  queue: null | {
    collectionId: string;
    collectionTitle: string;
    items: PresetCollectionItem[];
    currentPosition: number;
  };
}

interface PersistedQueue extends NonNullable<CollectionQueueState['queue']> {
  version: 1;
}

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface RevisionLoader {
  getPublishedPresetRevision(id: string, revisionId: string): Promise<PublishedPresetRevisionView>;
}

interface ToneApplicator {
  apply(preset: ApplicablePublishedPreset): Promise<LoadPresetResult>;
}

export interface CollectionQueueSession {
  start(collection: PresetCollection, position: number): Promise<LoadPresetResult>;
  switchTo(position: number): Promise<LoadPresetResult>;
  previousPosition(): number | null;
  nextPosition(): number | null;
  clear(): void;
  getState(): CollectionQueueState;
  subscribe(listener: () => void): () => void;
}

function validItem(value: unknown, position: number): value is PresetCollectionItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<PresetCollectionItem>;
  return item.position === position
    && typeof item.presetId === 'string'
    && typeof item.revisionId === 'string'
    && (item.availability === 'available' || item.availability === 'unavailable')
    && (typeof item.title === 'string' || item.title === null)
    && Boolean(item.creator)
    && typeof item.creator?.id === 'string'
    && typeof item.creator?.handle === 'string'
    && typeof item.creator?.displayName === 'string';
}

function loadPersisted(storage?: SessionStorageLike): PersistedQueue | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(SESSION_KEY) ?? 'null') as Partial<PersistedQueue> | null;
    if (
      value?.version !== 1
      || typeof value.collectionId !== 'string'
      || typeof value.collectionTitle !== 'string'
      || !Array.isArray(value.items)
      || !Number.isInteger(value.currentPosition)
      || value.currentPosition! < 0
      || value.currentPosition! >= value.items.length
      || !value.items.every(validItem)
      || value.items[value.currentPosition!]?.availability !== 'available'
    ) return null;
    return value as PersistedQueue;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

function applicable(view: PublishedPresetRevisionView): ApplicablePublishedPreset {
  return {
    id: view.id,
    title: view.title,
    creator: view.creator,
    updatedAt: view.updatedAt,
    currentRevision: view.revision,
  };
}

export function createCollectionQueueSession(
  revisions: RevisionLoader,
  tones: ToneApplicator,
  storage?: SessionStorageLike,
): CollectionQueueSession {
  let persisted = loadPersisted(storage);
  let snapshot: CollectionQueueState = { queue: persisted };
  const listeners = new Set<() => void>();

  const notify = () => {
    snapshot = { queue: persisted };
    listeners.forEach((listener) => listener());
  };
  const save = () => {
    try {
      if (persisted) storage?.setItem(SESSION_KEY, JSON.stringify(persisted));
      else storage?.removeItem(SESSION_KEY);
    } catch { /* queue remains available in memory */ }
  };
  const activate = async (
    collection: Omit<PersistedQueue, 'version' | 'currentPosition'>,
    position: number,
  ): Promise<LoadPresetResult> => {
    const item = collection.items[position];
    if (!item || item.availability !== 'available') {
      return { ok: false, message: '这个合集位置当前不可用。' };
    }
    try {
      const revision = await revisions.getPublishedPresetRevision(item.presetId, item.revisionId);
      const result = await tones.apply(applicable(revision));
      if (result.ok) {
        persisted = { version: 1, ...collection, currentPosition: position };
        save();
        notify();
      }
      return result;
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : '无法载入这个固定修订。',
      };
    }
  };
  const adjacent = (direction: -1 | 1): number | null => {
    if (!persisted) return null;
    for (
      let position = persisted.currentPosition + direction;
      position >= 0 && position < persisted.items.length;
      position += direction
    ) {
      if (persisted.items[position].availability === 'available') return position;
    }
    return null;
  };

  return {
    start(collection, position) {
      return activate({
        collectionId: collection.id,
        collectionTitle: collection.title,
        items: structuredClone(collection.items),
      }, position);
    },
    switchTo(position) {
      if (!persisted) return Promise.resolve({ ok: false, message: '当前没有 Collection 队列。' });
      return activate(persisted, position);
    },
    previousPosition: () => adjacent(-1),
    nextPosition: () => adjacent(1),
    clear() {
      persisted = null;
      save();
      notify();
    },
    getState: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
