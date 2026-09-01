import type { LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
}

/** Empty-search / empty-list placeholder: icon + title + optional hint. */
export function EmptyState({ icon: Icon, title, hint }: EmptyStateProps) {
  return (
    <div className="mk-empty-state">
      <Icon className="mk-empty-state__icon" size={28} strokeWidth={1.5} aria-hidden="true" />
      <p className="mk-empty-state__title">{title}</p>
      {hint && <p className="mk-empty-state__hint">{hint}</p>}
    </div>
  );
}
