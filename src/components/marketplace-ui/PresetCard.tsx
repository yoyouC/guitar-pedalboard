import { Heart } from 'lucide-react';
import type { MarketplaceTag } from '../../../shared/marketplace';
import { MiniRigChain } from './MiniRigChain';
import { TagBadge } from './TagBadge';

const MAX_TAGS = 3;

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface PresetCardProps {
  id: string;
  title: string;
  creatorHandle: string;
  pedalIds: string[];
  ampId?: string;
  ampName?: string;
  tags?: MarketplaceTag[];
  likeCount?: number;
  /** ISO date string. */
  createdAt?: string;
  /** When set, the whole card renders as a link. */
  href?: string;
  onClick?: () => void;
}

/** Marketplace preset card: generated rig visual + title/creator/tags/meta. */
export function PresetCard({
  id,
  title,
  creatorHandle,
  pedalIds,
  ampId,
  ampName,
  tags = [],
  likeCount,
  createdAt,
  href,
  onClick,
}: PresetCardProps) {
  const visual = (
    <MiniRigChain pedalIds={pedalIds} ampId={ampId} ampName={ampName} seed={id} />
  );
  const body = (
    <div className="mk-preset-card__body">
      <h3 className="mk-preset-card__title">{title}</h3>
      <span className="mk-preset-card__creator">@{creatorHandle}</span>
      {tags.length > 0 && (
        <div className="mk-preset-card__tags">
          {tags.slice(0, MAX_TAGS).map((tag) => (
            <TagBadge key={tag.id} label={tag.nameEn} />
          ))}
        </div>
      )}
      <div className="mk-preset-card__meta">
        {likeCount !== undefined && (
          <span className="mk-preset-card__likes">
            <Heart size={12} aria-hidden="true" />
            {likeCount}
          </span>
        )}
        {createdAt && <span>{formatDate(createdAt)}</span>}
      </div>
    </div>
  );

  if (href) {
    return (
      <a className="mk-card mk-card--interactive mk-preset-card" href={href} onClick={onClick}>
        {visual}
        {body}
      </a>
    );
  }
  return (
    <button type="button" className="mk-card mk-card--interactive mk-preset-card" onClick={onClick}>
      {visual}
      {body}
    </button>
  );
}

/** Loading placeholder matching PresetCard's layout. */
export function PresetCardSkeleton() {
  return (
    <div className="mk-card mk-preset-card" aria-hidden="true">
      <div className="mk-skeleton" style={{ aspectRatio: '16 / 8', borderRadius: 0 }} />
      <div className="mk-preset-card__body">
        <div className="mk-skeleton" style={{ height: 16, width: '70%' }} />
        <div className="mk-skeleton" style={{ height: 12, width: '40%' }} />
        <div className="mk-skeleton" style={{ height: 11, width: '55%' }} />
      </div>
    </div>
  );
}
