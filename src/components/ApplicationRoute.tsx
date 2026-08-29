import type { AppRoute } from '../app/route.ts';
import { CreatorProfileRoute } from './CreatorProfileRoute.tsx';
import { PresetCollectionRoute } from './PresetCollectionRoute.tsx';
import { PublishedPresetRoute } from './PublishedPresetRoute.tsx';
import { PublishedPresetSearchRoute } from './PublishedPresetSearchRoute.tsx';
import { LoginPage } from './LoginPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { PublishPage } from './PublishPage.tsx';
import { MyLibraryPage } from './MyLibraryPage.tsx';
import { ToneManagePage } from './ToneManagePage.tsx';
import { CollectionManagePage } from './CollectionManagePage.tsx';
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

export function ApplicationRoute(props: ApplicationRouteProps) {
  const { route, pathname, search, onNavigate } = props;
  const close = () => onNavigate('/');
  switch (route.kind) {
    case 'marketplace-search':
      return <PublishedPresetSearchRoute pathname={pathname} search={search} onClose={close} onNavigate={onNavigate} />;
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
    case 'publish':
      return <PublishPage onNavigate={onNavigate} />;
    case 'tone-manage':
      return <ToneManagePage pathname={pathname} onNavigate={onNavigate} />;
    case 'collection-manage':
      return <CollectionManagePage pathname={pathname} onNavigate={onNavigate} />;
    case 'library': return <MyLibraryPage search={search} onNavigate={onNavigate} />;
    case 'not-found':
      return (
        <section className="app-route-placeholder" role="alert">
          <span className="marketplace-detail__eyebrow">404</span>
          <h1>Page not found</h1>
          <p>The address does not match a Pedalboard or Tone Market page.</p>
          <div className="app-route-placeholder__actions">
            <button type="button" onClick={close}>Open Pedalboard</button>
            <button type="button" onClick={() => onNavigate('/marketplace')}>Explore Tone Market</button>
          </div>
        </section>
      );
  }
}
