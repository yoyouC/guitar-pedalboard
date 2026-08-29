import type { MouseEvent, ReactNode } from 'react';
import type { InputSourceType } from '../audio/AudioEngine.ts';
import type { AppSection } from '../app/route.ts';
import { MemberPanel } from './MemberPanel.tsx';

interface AppLinkProps {
  active: boolean;
  children: ReactNode;
  className?: string;
  href: string;
  onNavigate(pathname: string): void;
}

function AppLink({ active, children, className = '', href, onNavigate }: AppLinkProps) {
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;
    event.preventDefault();
    onNavigate(href);
  };

  return (
    <a
      className={`app-header__link${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      href={href}
      aria-current={active ? 'page' : undefined}
      onClick={navigate}
    >
      {children}
    </a>
  );
}

const INPUT_LABEL: Record<InputSourceType, string> = {
  mic: 'Microphone',
  file: 'Audio file',
  test: 'Test tone',
};

interface ApplicationHeaderProps {
  section: AppSection;
  engineReady: boolean;
  inputType: InputSourceType | null;
  onNavigate(pathname: string): void;
  onStopInput(): void;
}

export function ApplicationHeader({
  section,
  engineReady,
  inputType,
  onNavigate,
  onStopInput,
}: ApplicationHeaderProps) {
  const audioActive = engineReady && inputType !== null;

  return (
    <header className="app-header">
      <AppLink
        active={false}
        className="app-header__brand"
        href="/"
        onNavigate={onNavigate}
      >
        <span className="app-header__brand-mark" aria-hidden="true">🎸</span>
        <span className="app-header__brand-text">Guitar Pedalboard</span>
      </AppLink>
      <nav className="app-header__nav" aria-label="Primary navigation">
        <AppLink active={section === 'pedalboard'} href="/" onNavigate={onNavigate}>
          Pedalboard
        </AppLink>
        <AppLink
          active={section === 'marketplace'}
          href="/marketplace/search"
          onNavigate={onNavigate}
        >
          Tone Market
        </AppLink>
      </nav>
      <div className="app-header__actions">
        {section !== 'pedalboard' && audioActive && (
          <div className="app-audio-status" role="status" aria-label="Audio input is active">
            <span className="app-audio-status__light" aria-hidden="true" />
            <span>
              <strong>Audio active</strong>
              <small>{INPUT_LABEL[inputType]}</small>
            </span>
            <button type="button" onClick={onStopInput}>Stop</button>
          </div>
        )}
        <MemberPanel onNavigate={onNavigate} />
      </div>
    </header>
  );
}
