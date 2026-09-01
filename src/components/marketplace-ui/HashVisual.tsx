import type { CSSProperties, ReactNode } from 'react';
import { hashString } from './hash';

export interface HashVisualProps {
  /** Seed (usually an entity id) for the deterministic two-hue gradient. */
  seed: string;
  className?: string;
  children?: ReactNode;
}

/**
 * Seeded gradient backdrop for marketplace entities that carry no imagery
 * (collections, creator works, ranking summaries). Same hash treatment as
 * MiniRigChain's card backdrop.
 */
export function HashVisual({ seed, className, children }: HashVisualProps) {
  const h = hashString(seed);
  const hueA = h % 360;
  const hueB = (hueA + 36 + ((h >> 9) % 48)) % 360;
  const style: CSSProperties = {
    background: `linear-gradient(135deg, hsl(${hueA} 28% 13%), hsl(${hueB} 24% 9%))`,
  };
  return (
    <div className={className} style={style} aria-hidden="true">
      {children}
    </div>
  );
}
