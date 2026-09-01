import { Layers } from 'lucide-react';
import type { MarketplaceTag } from '../../../shared/marketplace';
import { HashVisual } from './HashVisual';
import { TagBadge } from './TagBadge';

const MAX_TAGS = 3;

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface CollectionCardProps {
  id: string;
  title: string;
  description: string;
  creatorHandle: string;
  tags?: MarketplaceTag[];
  /** ISO date string. */
  createdAt?: string;
  onClick?: () => void;
}

/**
 * Marketplace collection card: gradient backdrop seeded by the collection id
 * (same hash treatment as MiniRigChain, since collections have no imagery)
 * plus title, clamped description, creator, tags, and date.
 */
export function CollectionCard({
  id,
  title,
  description,
  creatorHandle,
  tags = [],
  createdAt,
  onClick,
}: CollectionCardProps) {
  return (
    <button
      type="button"
      className="mk-card mk-card--interactive mk-collection-card"
      onClick={onClick}
    >
      <HashVisual seed={id} className="mk-collection-card__visual">
        <span className="mk-collection-card__stack">
          <Layers size={26} strokeWidth={1.5} />
        </span>
      </HashVisual>
      <div className="mk-preset-card__body">
        <h3 className="mk-preset-card__title">{title}</h3>
        <p className="mk-collection-card__description">
          {description || 'No description provided.'}
        </p>
        <span className="mk-preset-card__creator">@{creatorHandle}</span>
        {tags.length > 0 && (
          <div className="mk-preset-card__tags">
            {tags.slice(0, MAX_TAGS).map((tag) => (
              <TagBadge key={tag.id} label={tag.nameEn} />
            ))}
          </div>
        )}
        {createdAt && (
          <div className="mk-preset-card__meta">
            <span>{formatDate(createdAt)}</span>
          </div>
        )}
      </div>
    </button>
  );
}
