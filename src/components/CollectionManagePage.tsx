import { useEffect, useState } from 'react';
import type { PresetCollection } from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';
import { PresetCollectionManager } from './PresetCollectionManager';

interface Props {
  pathname: string;
  onNavigate(pathname: string): void;
}

function collectionId(pathname: string): string | null {
  const match = /^\/library\/collections\/([^/]+)\/?$/.exec(pathname);
  try { return match ? decodeURIComponent(match[1]) : null; } catch { return null; }
}

export function CollectionManagePage({ pathname, onNavigate }: Props) {
  const id = collectionId(pathname);
  const [collection, setCollection] = useState<PresetCollection | null>(null);
  const [message, setMessage] = useState('Loading collection…');
  useEffect(() => {
    if (!id) return;
    let active = true;
    void marketplaceClient.getManagedPresetCollection(id).then((value) => {
      if (active) { setCollection(value); setMessage(''); }
    }, (cause: unknown) => {
      if (active) setMessage(cause instanceof Error ? cause.message : 'Could not load this collection.');
    });
    return () => { active = false; };
  }, [id]);
  return (
    <section className="library-page">
      <button type="button" onClick={() => onNavigate('/library?tab=collections')}>← My Collections</button>
      {message && <p role="status">{message}</p>}
      {collection && <PresetCollectionManager collection={collection} onUpdated={setCollection} />}
    </section>
  );
}
