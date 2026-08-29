import type { AppRoute } from '../app/route.ts';
import { CreatorProfileRoute } from './CreatorProfileRoute.tsx';
import { PresetCollectionRoute } from './PresetCollectionRoute.tsx';
import { PublishedPresetRoute } from './PublishedPresetRoute.tsx';
import { PublishedPresetSearchRoute } from './PublishedPresetSearchRoute.tsx';

interface ApplicationRouteProps {
  route: Exclude<AppRoute, { kind: 'pedalboard' }>;
  pathname: string;
  onNavigate(pathname: string): void;
}

const PLACEHOLDER_COPY = {
  login: {
    eyebrow: 'Member access',
    title: 'Login is moving here',
    description: 'For now, use the member menu in the header. The dedicated sign-in flow arrives in the next member-experience slice.',
  },
  library: {
    eyebrow: 'Member workspace',
    title: 'My Library is being prepared',
    description: 'Published Tone, Collections and Likes will live here without mixing them with browser-local Presets.',
  },
  settings: {
    eyebrow: 'Persistent preferences',
    title: 'Settings is being prepared',
    description: 'Audio, MIDI, appearance and account preferences will move here while performance controls remain on the Pedalboard.',
  },
} as const;

export function ApplicationRoute({ route, pathname, onNavigate }: ApplicationRouteProps) {
  const close = () => onNavigate('/');
  switch (route.kind) {
    case 'marketplace-search':
      return <PublishedPresetSearchRoute pathname={pathname} onClose={close} onNavigate={onNavigate} />;
    case 'published-preset':
      return <PublishedPresetRoute pathname={pathname} onClose={close} onNavigate={onNavigate} />;
    case 'preset-collection':
      return <PresetCollectionRoute pathname={pathname} onClose={close} onNavigate={onNavigate} />;
    case 'creator-profile':
      return <CreatorProfileRoute pathname={pathname} onClose={close} onNavigate={onNavigate} />;
    case 'login':
    case 'library':
    case 'settings': {
      const copy = PLACEHOLDER_COPY[route.kind];
      return (
        <section className="app-route-placeholder">
          <span className="marketplace-detail__eyebrow">{copy.eyebrow}</span>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
          <button type="button" onClick={close}>Return to Pedalboard</button>
        </section>
      );
    }
    case 'not-found':
      return (
        <section className="app-route-placeholder" role="alert">
          <span className="marketplace-detail__eyebrow">404</span>
          <h1>Page not found</h1>
          <p>The address does not match a Pedalboard or Tone Market page.</p>
          <div className="app-route-placeholder__actions">
            <button type="button" onClick={close}>Open Pedalboard</button>
            <button type="button" onClick={() => onNavigate('/marketplace/search')}>Explore Tone Market</button>
          </div>
        </section>
      );
  }
}

