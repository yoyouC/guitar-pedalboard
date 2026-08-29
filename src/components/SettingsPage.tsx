import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CURRENT_MEMBER_TERMS_VERSION } from '../../shared/memberTerms.ts';
import { AUDIO_PROFILES, audioProfileDefinition, type AudioProfile } from '../audio/audioProfile.ts';
import { audioEngine } from '../audio/AudioEngine.ts';
import type { AudioDiagnosticsSnapshot } from '../audio/audioDiagnostics.ts';
import type { AppLocale, AppPreferences, BackgroundTheme } from '../app/preferences.ts';
import type { MidiBinding } from '../midi/midiLearn.ts';
import type { MidiState } from '../midi/useMidi.ts';
import { beginGoogleAuth, updateMemberProfile } from '../members/client.ts';
import { memberSession } from '../members/session.ts';
import { useMemberSession } from '../members/useMemberSession.ts';
import type { MarketplaceAccountDeletion } from '../../shared/account.ts';
import {
  fetchMarketplaceAccountDeletion,
  fetchMarketplaceAccountExport,
  MarketplaceAccountClientError,
  recoverMarketplaceAccount,
  requestMarketplaceAccountDeletion,
} from '../accounts/client.ts';

interface SettingsPageProps {
  preferences: AppPreferences;
  onPreferencesChange(preferences: AppPreferences): void;
  diagnostics: AudioDiagnosticsSnapshot;
  engineReady: boolean;
  midi: MidiState;
  midiBindings: MidiBinding[];
  onClearMidiBindings(): void;
  onNavigate(pathname: string): void;
  search: string;
}

const AUDIO_PROFILE_EN: Record<AudioProfile, { label: string; description: string }> = {
  realtime: { label: 'Live performance', description: 'Prioritize the lowest monitoring latency' },
  balanced: { label: 'Balanced', description: 'Balance latency, stability and power' },
  stable: { label: 'Stable playback', description: 'Prioritize continuity over live monitoring' },
};

export function SettingsPage(props: SettingsPageProps) {
  const session = useMemberSession();
  const [switchingAudio, setSwitchingAudio] = useState(false);
  const [message, setMessage] = useState('');
  const locale = props.preferences.locale;

  useEffect(() => {
    const section = new URLSearchParams(props.search).get('section');
    if (section && ['audio', 'midi', 'appearance', 'account'].includes(section)) {
      document.getElementById(section)?.scrollIntoView({ block: 'start' });
    }
  }, [props.search]);

  const setPreference = <Key extends keyof AppPreferences>(
    key: Key,
    value: AppPreferences[Key],
  ) => props.onPreferencesChange({ ...props.preferences, [key]: value });

  const switchAudioProfile = async (profile: AudioProfile) => {
    if (profile === props.diagnostics.profile) return;
    if (props.engineReady && !window.confirm(
      locale === 'zh-CN' ? '切换音频档位会短暂重建音频设备。继续吗？' : 'Changing profile briefly rebuilds the audio device. Continue?',
    )) return;
    setSwitchingAudio(true);
    const result = await audioEngine.switchAudioProfile(profile);
    setSwitchingAudio(false);
    setMessage(result.ok
      ? locale === 'zh-CN' ? '音频档位已切换。' : 'Audio profile changed.'
      : result.message ?? 'Audio profile could not be changed.');
  };

  return (
    <section className="settings-page">
      <header className="settings-page__title">
        <span className="marketplace-detail__eyebrow">Persistent preferences</span>
        <h1>{locale === 'zh-CN' ? '设置' : 'Settings'}</h1>
        <p>{locale === 'zh-CN'
          ? '这里保存跨会话偏好；演奏中要即时操作的输入、输出、调音器和表头仍在 Pedalboard。'
          : 'Cross-session preferences live here. Live input, output, tuner and meter controls stay on the Pedalboard.'}</p>
      </header>

      <nav className="settings-page__index" aria-label="Settings sections">
        {['audio', 'midi', 'appearance', 'account'].map((section) => (
          <button key={section} type="button" onClick={() => props.onNavigate(`/settings?section=${section}`)}>
            {section === 'midi' ? 'MIDI' : section[0].toUpperCase() + section.slice(1)}
          </button>
        ))}
      </nav>

      <SettingsSection id="audio" title="Audio" description={locale === 'zh-CN' ? '启动档位与稳定性偏好' : 'Startup latency and stability profile'}>
        <label>
          {locale === 'zh-CN' ? '音频档位' : 'Audio profile'}
          <select
            value={props.diagnostics.profile}
            disabled={switchingAudio}
            onChange={(event) => void switchAudioProfile(event.target.value as AudioProfile)}
          >
            {AUDIO_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {locale === 'zh-CN'
                  ? `${profile.label} — ${profile.description}`
                  : `${AUDIO_PROFILE_EN[profile.id].label} — ${AUDIO_PROFILE_EN[profile.id].description}`}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-page__hint">{audioProfileDefinition(props.diagnostics.profile).latencyHint} · 48 kHz requested</p>
      </SettingsSection>

      <SettingsSection id="midi" title="MIDI" description={locale === 'zh-CN' ? '连接状态和自定义映射' : 'Connection and custom mappings'}>
        <dl className="settings-page__facts">
          <dt>Status</dt><dd>{!props.midi.supported ? 'Unsupported' : props.midi.deviceName ?? (props.midi.enabled ? 'Ready · no input' : 'Permission unavailable')}</dd>
          <dt>Custom mappings</dt><dd>{props.midiBindings.length}</dd>
        </dl>
        <button type="button" disabled={props.midiBindings.length === 0} onClick={props.onClearMidiBindings}>
          {locale === 'zh-CN' ? '清除自定义 MIDI 映射' : 'Clear custom MIDI mappings'}
        </button>
        <p className="settings-page__hint">{locale === 'zh-CN' ? '学习新映射仍在 Pedalboard 的 MIDI 面板中完成。' : 'Learn new mappings from the live MIDI panel on the Pedalboard.'}</p>
      </SettingsSection>

      <SettingsSection id="appearance" title="Appearance" description={locale === 'zh-CN' ? '语言、背景与动态效果' : 'Language, background and motion'}>
        <label>
          Language
          <select value={locale} onChange={(event) => setPreference('locale', event.target.value as AppLocale)}>
            <option value="zh-CN">中文</option><option value="en">English</option>
          </select>
        </label>
        <label>
          {locale === 'zh-CN' ? 'Pedalboard 背景' : 'Pedalboard background'}
          <select value={props.preferences.background} onChange={(event) => setPreference('background', event.target.value as BackgroundTheme)}>
            <option value="meddle">Meddle</option><option value="prism">Prism</option><option value="fluid">Fluid</option>
          </select>
        </label>
        <label className="settings-page__check"><input type="checkbox" checked={props.preferences.reducedMotion} onChange={(event) => setPreference('reducedMotion', event.target.checked)} />{locale === 'zh-CN' ? '减少动态效果' : 'Reduce motion'}</label>
        <label className="settings-page__check"><input type="checkbox" checked={props.preferences.reduceVisualLoad} onChange={(event) => setPreference('reduceVisualLoad', event.target.checked)} />{locale === 'zh-CN' ? '降低视觉负载（同时关闭表头与调音器）' : 'Reduce visual load (also disables meters and tuner)'}</label>
      </SettingsSection>

      <SettingsSection id="account" title="Account" description={locale === 'zh-CN' ? '私有身份与公开署名资料' : 'Private identity and public attribution'}>
        {session.status === 'authenticated' ? (
          <AccountSettings locale={locale} onNavigate={props.onNavigate} />
        ) : session.status === 'loading' ? <p>…</p> : (
          <button type="button" onClick={() => props.onNavigate(`/login?return=${encodeURIComponent('/settings?section=account')}`)}>
            {locale === 'zh-CN' ? '登录以管理账户' : 'Sign in to manage account'}
          </button>
        )}
      </SettingsSection>
      {message && <p className="settings-page__message" role="status">{message}</p>}
    </section>
  );
}

function SettingsSection({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return <section className="settings-page__section" id={id}><header><div><h2>{title}</h2><p>{description}</p></div></header><div className="settings-page__controls">{children}</div></section>;
}

function AccountSettings({ locale, onNavigate }: { locale: AppLocale; onNavigate(pathname: string): void }) {
  const session = useMemberSession();
  const member = session.status === 'authenticated' ? session.member : null;
  const [handle, setHandle] = useState(member?.handle ?? '');
  const [displayName, setDisplayName] = useState(member?.displayName ?? '');
  const [bio, setBio] = useState(member?.bio ?? '');
  const [acceptTerms, setAcceptTerms] = useState(member?.readyForPublicAttribution ?? false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [deletion, setDeletion] = useState<MarketplaceAccountDeletion | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState(true);
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');

  useEffect(() => {
    if (!member) return;
    setHandle(member.handle); setDisplayName(member.displayName); setBio(member.bio);
    setAcceptTerms(member.readyForPublicAttribution);
  }, [member]);
  useEffect(() => {
    let active = true;
    setLifecycleLoading(true);
    void fetchMarketplaceAccountDeletion().then(
      (next) => { if (active) { setDeletion(next); setLifecycleLoading(false); } },
      (cause: unknown) => { if (active) { setMessage(cause instanceof Error ? cause.message : '无法读取账户状态。'); setLifecycleLoading(false); } },
    );
    return () => { active = false; };
  }, []);
  if (!member) return null;

  const requireRecentAuthentication = async (cause: unknown): Promise<boolean> => {
    if (!(cause instanceof MarketplaceAccountClientError)
      || cause.code !== 'recent_authentication_required' || !cause.verificationUrl) return false;
    setMessage(locale === 'zh-CN' ? '此操作需要重新验证身份；你的选择已保留。' : 'Re-authenticate to continue; your choice is preserved.');
    await memberSession.logout();
    onNavigate(cause.verificationUrl);
    return true;
  };

  const downloadExport = async () => {
    setBusy(true); setMessage('');
    try {
      const exported = await fetchMarketplaceAccountExport();
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported.data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = exported.filename; link.click();
      URL.revokeObjectURL(url);
      setMessage(locale === 'zh-CN' ? '账户数据已导出。' : 'Account data exported.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Account export failed.');
    } finally { setBusy(false); }
  };

  const requestDeletion = async () => {
    setBusy(true); setMessage('');
    try {
      const next = await requestMarketplaceAccountDeletion();
      setDeletion(next);
      await memberSession.refresh();
      onNavigate(`/login?return=${encodeURIComponent('/settings?section=account')}`);
    } catch (cause) {
      if (!await requireRecentAuthentication(cause)) {
        setMessage(cause instanceof Error ? cause.message : 'Account deletion failed.');
      }
    } finally { setBusy(false); }
  };

  const restoreAccount = async () => {
    setBusy(true); setMessage('');
    try {
      await recoverMarketplaceAccount();
      setDeletion(null);
      setMessage(locale === 'zh-CN' ? '账户已恢复；公开作品会按原可见性重新出现。' : 'Account restored.');
      await memberSession.refresh();
    } catch (cause) {
      if (!await requireRecentAuthentication(cause)) {
        setMessage(cause instanceof Error ? cause.message : 'Account recovery failed.');
      }
    } finally { setBusy(false); }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const next = await updateMemberProfile({
        handle,
        displayName,
        bio,
        ...(acceptTerms ? { termsAcceptedVersion: CURRENT_MEMBER_TERMS_VERSION } : {}),
        expectedUpdatedAt: member.updatedAt,
      });
      memberSession.replaceMember(next);
      setMessage(locale === 'zh-CN' ? '账户资料已保存。' : 'Account profile saved.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not save profile.');
    } finally { setBusy(false); }
  };

  const linkGoogle = async () => {
    setBusy(true);
    setMessage('');
    try {
      window.location.assign(await beginGoogleAuth('link', '/settings?section=account'));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Google linking is unavailable.');
      setBusy(false);
    }
  };

  return (
    <form className="settings-account" onSubmit={(event) => void save(event)}>
      <div className={`settings-account__readiness ${member.readyForPublicAttribution ? 'ready' : ''}`}>
        <strong>{member.readyForPublicAttribution ? '✓ Public attribution ready' : 'Public attribution setup required'}</strong>
        <small>{locale === 'zh-CN' ? 'Like 等私有动作不要求完成此步骤；发布和创建公开作品前需要。' : 'Private actions such as Likes do not require this; publishing does.'}</small>
      </div>
      {lifecycleLoading && <p>正在读取账户状态…</p>}
      {deletion && (
        <section className="settings-account__lifecycle settings-account__danger" aria-label="恢复账户">
          <strong>账户正在等待最终删除</strong>
          <p>公开作品已立即撤下。你可以在 {new Date(deletion.purgeAfter).toLocaleString()} 前恢复账户；我们不会静默恢复。</p>
          <button disabled={busy} type="button" onClick={() => void restoreAccount()}>恢复账户</button>
        </section>
      )}
      <label>
        Handle
        <input
          required
          pattern="[a-z0-9][a-z0-9\-]{1,28}[a-z0-9]"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
        />
      </label>
      <label>
        {locale === 'zh-CN' ? '显示名' : 'Display name'}
        <input required maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      <label>
        {locale === 'zh-CN' ? '简介' : 'Bio'}
        <textarea maxLength={500} value={bio} onChange={(event) => setBio(event.target.value)} />
      </label>
      <details className="settings-account__terms">
        <summary>{locale === 'zh-CN' ? '社区条款摘要' : 'Community terms summary'}</summary>
        <p>{locale === 'zh-CN'
          ? '发布后，署名资料与作品元数据会公开；你必须拥有发布内容所需权利，并同意平台为展示、检索和安全审核处理这些数据。'
          : 'Publishing makes attribution and work metadata public. You must hold the necessary rights and allow the service to process that data for display, search and safety review.'}</p>
      </details>
      <label className="settings-page__check">
        <input
          type="checkbox"
          required={!member.readyForPublicAttribution}
          checked={acceptTerms}
          onChange={(event) => setAcceptTerms(event.target.checked)}
        />
        {locale === 'zh-CN'
          ? `我确认当前社区条款（${CURRENT_MEMBER_TERMS_VERSION}）`
          : `I accept the current community terms (${CURRENT_MEMBER_TERMS_VERSION})`}
      </label>
      <div className="settings-account__actions">
        <button disabled={busy} type="submit">{busy ? '…' : locale === 'zh-CN' ? '保存账户资料' : 'Save account profile'}</button>
        <button disabled={busy} type="button" onClick={() => void linkGoogle()}>{locale === 'zh-CN' ? '验证并绑定 Google' : 'Verify and link Google'}</button>
        <button type="button" onClick={() => onNavigate(`/creators/${encodeURIComponent(member.handle)}`)}>{locale === 'zh-CN' ? '公开主页' : 'Public profile'}</button>
        <button disabled={busy} type="button" onClick={() => void downloadExport()}>{locale === 'zh-CN' ? '导出我的数据（JSON）' : 'Export my data (JSON)'}</button>
        <button type="button" onClick={() => onNavigate('/marketplace/me/moderation')}>{locale === 'zh-CN' ? '治理记录与申诉' : 'Moderation cases and appeals'}</button>
      </div>
      {!deletion && (
        <details className="settings-account__lifecycle settings-account__danger">
          <summary>注销账户</summary>
          <p>提交后会立即退出登录并撤下你的公开作品。30 天内重新验证身份后，可在这里选择恢复账户；到期后会最终删除个人资料和作品内容，只保留匿名化的归属、治理与审计占位信息。</p>
          <label className="settings-page__check">
            <input type="checkbox" checked={deleteAcknowledged} onChange={(event) => setDeleteAcknowledged(event.target.checked)} />
            我理解此操作覆盖账户、预设、合集和社区关系。
          </label>
          <label>
            输入 Handle “{member.handle}” 进行第二次确认
            <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} />
          </label>
          <button
            disabled={busy || !deleteAcknowledged || deleteConfirmation !== member.handle}
            type="button"
            onClick={() => void requestDeletion()}
          >确认注销账户</button>
        </details>
      )}
      {message && <p role="status">{message}</p>}
    </form>
  );
}
