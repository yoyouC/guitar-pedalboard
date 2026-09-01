import type { CSSProperties } from 'react';
import { hueFromString } from './hash';

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part[0]).join('');
}

function formatJoinDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export interface CreatorRowProps {
  displayName: string;
  handle: string;
  bio: string;
  /** ISO date string. */
  createdAt?: string;
  onClick?: () => void;
}

/**
 * Creator search-result row: initials avatar (hue from handle), display name +
 * handle, clamped bio, join date. The whole row is the link to the profile;
 * aria-label keeps the accessible name equal to the display name.
 */
export function CreatorRow({ displayName, handle, bio, createdAt, onClick }: CreatorRowProps) {
  return (
    <button
      type="button"
      className="mk-card mk-card--interactive mk-creator-row"
      aria-label={displayName}
      onClick={onClick}
    >
      <span
        className="mk-avatar mk-creator-row__avatar"
        style={{ '--mk-avatar-hue': hueFromString(handle) } as CSSProperties}
        aria-hidden="true"
      >
        {initials(displayName)}
      </span>
      <span className="mk-creator-row__main">
        <span className="mk-creator-row__name">
          {displayName}
          <span className="mk-creator-row__handle">@{handle}</span>
        </span>
        <span className="mk-creator-row__bio">{bio || 'No bio yet.'}</span>
      </span>
      {createdAt && (
        <span className="mk-creator-row__joined">Joined {formatJoinDate(createdAt)}</span>
      )}
    </button>
  );
}
