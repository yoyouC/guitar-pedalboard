export interface TagBadgeProps {
  /** Display label, typically `MarketplaceTag.nameEn`. */
  label: string;
}

/** Small marketplace tag chip. */
export function TagBadge({ label }: TagBadgeProps) {
  return <span className="mk-tag">{label}</span>;
}
