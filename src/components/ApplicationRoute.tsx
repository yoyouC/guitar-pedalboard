import type { AppRoute } from '../app/route.ts';
import { CreatorProfileRoute } from './CreatorProfileRoute.tsx';
import { PresetCollectionRoute } from './PresetCollectionRoute.tsx';
import { PublishedPresetRoute } from './PublishedPresetRoute.tsx';
import { PublishedPresetSearchRoute } from './PublishedPresetSearchRoute.tsx';
import { LoginPage } from './LoginPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import type { AppPreferences } from '../app/preferences.ts';
import type { AudioDiagnosticsSnapshot } from '../audio/audioDiagnostics.ts';
import type { MidiState } from '../midi/useMidi.ts';
import type { MidiBinding } from '../midi/midiLearn.ts';

interface ApplicationRouteProps {
  route: Exclude<AppRoute, { kind: 'pedalboard' }>;
  pathname: string;
  search: string;
  onNavigate(pathname: string): void;
  preferences: AppPreferences;
  onPreferencesChange(preferences: AppPreferences): void;
  diagnostics: AudioDiagnosticsSnapshot;
  engineReady: boolean;
  midi: MidiState;
  midiBindings: MidiBinding[];
  onClearMidiBindings(): void;
}

const PLACEHOLDER_COPY = {
  library: {
    eyebrow: 'Member workspace',
    title: 'My Library is being prepared',
    description: 'Published Tone, Collections and Likes will live here without mixing them with browser-local Presets.',
  },
} as const;

export function ApplicationRoute(props: ApplicationRouteProps) {
  const { route, pathname, onNavigate } = props;
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
      return <LoginPage locale={props.preferences.locale} search={props.search} onNavigate={onNavigate} />;
    case 'settings':
      return <SettingsPage {...props} />;
    case 'library': {
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
