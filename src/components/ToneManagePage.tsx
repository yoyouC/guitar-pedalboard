import { useEffect, useState } from 'react';
import type { PublishedPreset } from '../../shared/marketplace';
import { marketplaceClient } from '../marketplace/client';
import { PublishedPresetManager } from './PublishedPresetManager';

interface Props { pathname: string; onNavigate(pathname: string): void }
export function ToneManagePage({ pathname, onNavigate }: Props) {
  const match = /^\/library\/tones\/([^/]+)\/?$/.exec(pathname);
  const id = match ? decodeURIComponent(match[1]) : '';
  const [preset, setPreset] = useState<PublishedPreset | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void marketplaceClient.getManagedPublishedPreset(id).then((value) => { if (active) setPreset(value); }, (cause: unknown) => { if (active) setMessage(cause instanceof Error ? cause.message : 'Manage 暂时不可用。'); });
    return () => { active = false; };
  }, [id]);
  return <section className="library-page"><button type="button" onClick={() => onNavigate('/library')}>← My Tones</button>{message && <p role="alert">{message}</p>}{!preset && !message && <p>正在读取 Tone 管理数据…</p>}{preset && <><span className="marketplace-detail__eyebrow">My Tones · Manage</span><h1>{preset.title}</h1><p>并发冲突会保留当前表单并要求重新载入，不提供盲目覆盖。</p><PublishedPresetManager preset={preset} onUpdated={setPreset} onNavigate={onNavigate} /></>}</section>;
}
