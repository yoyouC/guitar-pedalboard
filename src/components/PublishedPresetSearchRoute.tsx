import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  Layers,
  Search,
  SearchX,
  SlidersHorizontal,
  Users,
  X,
} from 'lucide-react';
import type {
  MarketplaceTag,
  PresetCollectionSearchItem,
  PublicCreatorSearchItem,
  PublishedPresetSearchItem,
  RigDerivedAttributes,
  RigResourceDependencyKey,
} from '../../shared/marketplace';
import { parseRigResourceDependencyKey } from '../../shared/marketplaceResource';
import { AMP_REGISTRY } from '../audio/amps';
import { CAB_SELECTOR_REGISTRY } from '../audio/cabs';
import { EFFECT_REGISTRY } from '../audio/effects';
import { marketplaceClient } from '../marketplace/client';
import { marketplaceSearchPath, marketplaceSearchRouteState } from '../marketplace/searchRoute';
import { tonePath } from '../marketplace/route';
import { CollectionCard } from './marketplace-ui/CollectionCard.tsx';
import { CreatorRow } from './marketplace-ui/CreatorRow.tsx';
import { EmptyState } from './marketplace-ui/EmptyState.tsx';
import { PresetCard, PresetCardSkeleton } from './marketplace-ui/PresetCard.tsx';

interface PublishedPresetSearchRouteProps {
  pathname: string;
  search: string;
  onClose(): void;
  onNavigate(pathname: string): void;
}

type DiscoveryTab = 'presets' | 'collections' | 'creators';

const SKELETON_COUNT = 8;
const STAGGER_STEP_MS = 30;
const STAGGER_CAP = 10;

function commaValues(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function resourceDependencyValues(value: string): RigResourceDependencyKey[] | null {
  const parsed = commaValues(value).map(parseRigResourceDependencyKey);
  return parsed.some((key) => key === null) ? null : parsed as RigResourceDependencyKey[];
}

function isoDate(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function localDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function PublishedPresetSearchRoute({
  pathname,
  search,
  onClose,
  onNavigate,
}: PublishedPresetSearchRouteProps) {
  const active = pathname === '/marketplace' || pathname === '/marketplace/';
  const routeState = useMemo(() => marketplaceSearchRouteState(search), [search]);
  const request = routeState.request;
  const [tab, setTab] = useState<DiscoveryTab>('presets');
  const [text, setText] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [pedals, setPedals] = useState('');
  const [amps, setAmps] = useState('');
  const [cabs, setCabs] = useState('');
  const [resourceKinds, setResourceKinds] = useState<RigDerivedAttributes['resourceKinds']>([]);
  const [resourceDependencies, setResourceDependencies] = useState('');
  const [publishedAfter, setPublishedAfter] = useState('');
  const [publishedBefore, setPublishedBefore] = useState('');
  const [tags, setTags] = useState<MarketplaceTag[]>([]);
  const [items, setItems] = useState<PublishedPresetSearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [collectionItems, setCollectionItems] = useState<PresetCollectionSearchItem[]>([]);
  const [collectionCursor, setCollectionCursor] = useState<string | null>(null);
  const [collectionText, setCollectionText] = useState('');
  const [creatorItems, setCreatorItems] = useState<PublicCreatorSearchItem[]>([]);
  const [creatorCursor, setCreatorCursor] = useState<string | null>(null);
  const [creatorText, setCreatorText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    if (!active) return;
    setText(request.text ?? '');
    setTagIds(request.tagIds ?? []);
    setPedals((request.pedalIds ?? []).join(', '));
    setAmps((request.ampIds ?? []).join(', '));
    setCabs((request.cabIds ?? []).join(', '));
    setResourceKinds(request.resourceKinds ?? []);
    setResourceDependencies((request.resourceDependencyKeys ?? []).join(', '));
    setPublishedAfter(localDate(request.publishedAfter));
    setPublishedBefore(localDate(request.publishedBefore));
  }, [active, request]);

  const runCollectionSearch = async (query: string, cursor: string | null, append: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const page = await marketplaceClient.searchPresetCollections({
        text: query, limit: 12, cursor: cursor ?? undefined,
      });
      setCollectionItems((current) => append ? [...current, ...page.items] : page.items);
      setCollectionCursor(page.nextCursor);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Collection search is unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const runCreatorSearch = async (query: string, cursor: string | null, append: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const page = await marketplaceClient.searchCreators({
        text: query, limit: 12, cursor: cursor ?? undefined,
      });
      setCreatorItems((current) => append ? [...current, ...page.items] : page.items);
      setCreatorCursor(page.nextCursor);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Creator search is unavailable.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    void marketplaceClient.listAvailableTags().then(
      (available) => { if (mounted) setTags(available); },
      () => { /* free text and equipment filters remain usable */ },
    );
    return () => { mounted = false; };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const previousTitle = document.title;
    document.title = 'Tone Market · Guitar Pedalboard';
    return () => { document.title = previousTitle; };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (routeState.error) {
      setItems([]);
      setNextCursor(null);
      setMessage(routeState.error);
      return;
    }
    let mounted = true;
    setBusy(true);
    setMessage('');
    void marketplaceClient.searchPublishedPresets(request).then(
      (page) => {
        if (!mounted) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setBusy(false);
      },
      (cause: unknown) => {
        if (!mounted) return;
        setItems([]);
        setNextCursor(null);
        setMessage(cause instanceof Error ? cause.message : 'Tone Market is unavailable.');
        setBusy(false);
      },
    );
    return () => { mounted = false; };
  }, [active, request, routeState.error]);

  if (!active) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFiltersOpen(false);
    if (tab === 'collections') {
      void runCollectionSearch(collectionText, null, false);
      return;
    }
    if (tab === 'creators') {
      void runCreatorSearch(creatorText, null, false);
      return;
    }
    const resourceDependencyKeys = resourceDependencyValues(resourceDependencies);
    if (!resourceDependencyKeys) {
      setMessage('Dependency keys must look like builtin, tone3000:<toneId>, or tone3000:<toneId>:<modelId>.');
      return;
    }
    onNavigate(marketplaceSearchPath({
      text,
      tagIds,
      pedalIds: commaValues(pedals),
      ampIds: commaValues(amps),
      cabIds: commaValues(cabs),
      resourceKinds,
      resourceDependencyKeys,
      publishedAfter: isoDate(publishedAfter),
      publishedBefore: isoDate(publishedBefore),
      limit: 12,
    }));
  };

  const searchLabel = tab === 'presets'
    ? 'Search tones, creators, or tags'
    : tab === 'collections'
      ? 'Search collection titles, descriptions, tags, or creators'
      : 'Search creators by handle or display name';
  const submitLabel = busy
    ? 'Searching…'
    : tab === 'presets' ? 'Search Tones' : tab === 'collections' ? 'Search Collections' : 'Search Creators';
  const countLabel = busy || message
    ? ''
    : tab === 'presets'
      ? `${items.length} ${items.length === 1 ? 'tone' : 'tones'}`
      : tab === 'collections'
        ? `${collectionItems.length} ${collectionItems.length === 1 ? 'collection' : 'collections'}`
        : `${creatorItems.length} ${creatorItems.length === 1 ? 'creator' : 'creators'}`;
  const activeTags = tab === 'presets'
    ? tags.filter((tag) => request.tagIds?.includes(tag.id))
    : [];
  const firstPage = !request.cursor;

  const filterGroup = (label: string, open: boolean, children: ReactNode) => (
    <details className="mk-filter-group" open={open || undefined}>
      <summary>
        <span>{label}</span>
        <ChevronDown className="mk-filter-group__chevron" size={14} aria-hidden="true" />
      </summary>
      <div className="mk-filter-group__body">{children}</div>
    </details>
  );

  return (
    <section className="mk-browse" aria-live="polite">
      <div className="mk-browse__mobilebar">
        <button
          type="button"
          className="mk-btn mk-btn--secondary"
          aria-expanded={filtersOpen}
          aria-controls="mk-browse-filters"
          onClick={() => setFiltersOpen(true)}
        >
          <SlidersHorizontal size={15} aria-hidden="true" />
          Filters
        </button>
      </div>

      {filtersOpen && (
        <div className="mk-browse__backdrop" aria-hidden="true" onClick={() => setFiltersOpen(false)} />
      )}

      <aside
        id="mk-browse-filters"
        className={filtersOpen ? 'mk-browse__sidebar mk-browse__sidebar--open' : 'mk-browse__sidebar'}
        aria-label="Search filters"
      >
        <form className="mk-browse__filters" onSubmit={submit}>
          <div className="mk-browse__filters-head">
            <span>Filters</span>
            <button
              type="button"
              className="mk-btn mk-btn--ghost"
              aria-label="Close filters"
              onClick={() => setFiltersOpen(false)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          <div className="mk-filter-group">
            <label className="mk-filter-group__label" htmlFor="mk-browse-search">{searchLabel}</label>
            <div className="mk-browse__search">
              <Search className="mk-browse__search-icon" size={15} aria-hidden="true" />
              <input
                id="mk-browse-search"
                className="mk-input"
                value={tab === 'presets' ? text : tab === 'collections' ? collectionText : creatorText}
                placeholder='Try "rock", "distortion", "ambient"…'
                onChange={(event) => {
                  if (tab === 'presets') setText(event.target.value);
                  else if (tab === 'collections') setCollectionText(event.target.value);
                  else setCreatorText(event.target.value);
                }}
              />
            </div>
          </div>

          {tab === 'presets' && filterGroup('Tags', true, (
            <div className="mk-filter-group__options">
              {tags.map((tag) => (
                <label key={tag.id} className="mk-filter-check">
                  <input
                    type="checkbox"
                    checked={tagIds.includes(tag.id)}
                    onChange={() => setTagIds((current) => current.includes(tag.id)
                      ? current.filter((id) => id !== tag.id)
                      : [...current, tag.id])}
                  />
                  {tag.nameEn}
                </label>
              ))}
            </div>
          ))}
          {tab === 'presets' && filterGroup('Pedals', false, (
            <label className="mk-filter-field">
              <span>Name or id, comma-separated</span>
              <input className="mk-input" list="market-pedals" value={pedals} onChange={(event) => setPedals(event.target.value)} />
            </label>
          ))}
          {tab === 'presets' && filterGroup('Amp', false, (
            <label className="mk-filter-field">
              <span>Name or id, comma-separated</span>
              <input className="mk-input" list="market-amps" value={amps} onChange={(event) => setAmps(event.target.value)} />
            </label>
          ))}
          {tab === 'presets' && filterGroup('Cab', false, (
            <label className="mk-filter-field">
              <span>Name or id, comma-separated</span>
              <input className="mk-input" list="market-cabs" value={cabs} onChange={(event) => setCabs(event.target.value)} />
            </label>
          ))}
          {tab === 'presets' && filterGroup('Date range', false, (
            <>
              <label className="mk-filter-field">
                <span>Published after</span>
                <input className="mk-input" type="datetime-local" value={publishedAfter} onChange={(event) => setPublishedAfter(event.target.value)} />
              </label>
              <label className="mk-filter-field">
                <span>Published before</span>
                <input className="mk-input" type="datetime-local" value={publishedBefore} onChange={(event) => setPublishedBefore(event.target.value)} />
              </label>
            </>
          ))}
          {tab === 'presets' && filterGroup('Resource dependencies', false, (
            <>
              <div className="mk-filter-group__options">
                <label className="mk-filter-check">
                  <input
                    type="checkbox"
                    checked={resourceKinds.includes('builtin')}
                    onChange={() => setResourceKinds((current) => current.includes('builtin')
                      ? current.filter((kind) => kind !== 'builtin')
                      : [...current, 'builtin'])}
                  />
                  Built-in resources
                </label>
                <label className="mk-filter-check">
                  <input
                    type="checkbox"
                    checked={resourceKinds.includes('tone3000')}
                    onChange={() => setResourceKinds((current) => current.includes('tone3000')
                      ? current.filter((kind) => kind !== 'tone3000')
                      : [...current, 'tone3000'])}
                  />
                  TONE3000
                </label>
              </div>
              <label className="mk-filter-field">
                <span>Exact dependencies</span>
                <input
                  className="mk-input"
                  value={resourceDependencies}
                  placeholder="builtin, tone3000:123:456"
                  onChange={(event) => setResourceDependencies(event.target.value)}
                />
              </label>
            </>
          ))}

          <datalist id="market-pedals">{EFFECT_REGISTRY.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
          <datalist id="market-amps">{AMP_REGISTRY.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
          <datalist id="market-cabs">{CAB_SELECTOR_REGISTRY.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>

          <button type="submit" className="mk-btn mk-btn--primary" disabled={busy}>{submitLabel}</button>
          {tab === 'presets' && (
            <small className="mk-browse__filters-note">
              Filters are written to the URL — shareable, and restorable via browser Back/Forward.
              Only equipment identities derived at publish time are matched, never knob values or raw Rig JSON.
            </small>
          )}
        </form>
      </aside>

      <div className="mk-browse__main">
        <header className="mk-browse__header">
          <div className="mk-browse__heading">
            <h1 className="mk-browse__title">Tone Market</h1>
            {countLabel && <span className="mk-browse__count">{countLabel}</span>}
          </div>
          <button type="button" className="mk-btn mk-btn--ghost" onClick={onClose}>
            <ArrowLeft size={15} aria-hidden="true" />
            Back to pedalboard
          </button>
        </header>

        <nav className="mk-browse__views" aria-label="Tone Market discovery views">
          <button type="button" className="mk-browse__view" aria-pressed>Search</button>
          <button type="button" className="mk-browse__view" onClick={() => onNavigate('/marketplace/popular')}>Popular</button>
          <button type="button" className="mk-browse__view" onClick={() => onNavigate('/marketplace/trending')}>Trending</button>
          <button type="button" className="mk-browse__view" onClick={() => onNavigate('/marketplace/latest')}>Latest</button>
        </nav>

        <nav className="mk-tabs" aria-label="Discovery type">
          {([
            ['presets', 'Presets'],
            ['collections', 'Collections'],
            ['creators', 'Creators'],
          ] as const).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              className="mk-tabs__tab"
              aria-pressed={tab === kind}
              onClick={() => {
                setTab(kind);
                setMessage('');
                if (kind === 'collections' && collectionItems.length === 0) {
                  void runCollectionSearch(collectionText, null, false);
                }
                if (kind === 'creators' && creatorItems.length === 0) {
                  void runCreatorSearch(creatorText, null, false);
                }
              }}
            >{label}</button>
          ))}
        </nav>

        {activeTags.length > 0 && (
          <div className="mk-browse__chips" aria-label="Active tag filters">
            {activeTags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="mk-chip"
                aria-label={`Remove tag filter ${tag.nameEn}`}
                onClick={() => onNavigate(marketplaceSearchPath({
                  ...request,
                  tagIds: (request.tagIds ?? []).filter((id) => id !== tag.id),
                  cursor: undefined,
                }))}
              >
                {tag.nameEn}
                <X size={12} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        {message && (
          <div className="mk-browse__error" role="alert">
            <strong>Tone Market search failed</strong>
            <p>{message}</p>
            <small>You can head back to the pedalboard and keep playing your local Rig.</small>
          </div>
        )}

        {tab === 'presets' && (busy && items.length === 0 ? (
          <div className="mk-grid">
            {Array.from({ length: SKELETON_COUNT }, (_, index) => <PresetCardSkeleton key={index} />)}
          </div>
        ) : (
          <div className="mk-grid">
            {items.map((item, index) => (
              <div
                key={item.id}
                className={firstPage ? 'mk-grid__item mk-grid__item--enter' : 'mk-grid__item mk-grid__item--append'}
                style={firstPage ? { animationDelay: `${Math.min(index, STAGGER_CAP) * STAGGER_STEP_MS}ms` } : undefined}
              >
                <PresetCard
                  id={item.id}
                  title={item.title}
                  creatorHandle={item.creator.handle}
                  pedalIds={item.derivedAttributes.pedalIds}
                  ampId={item.derivedAttributes.ampId}
                  tags={item.tags}
                  createdAt={item.createdAt}
                  onClick={() => onNavigate(tonePath(item.id))}
                />
              </div>
            ))}
          </div>
        ))}

        {tab === 'collections' && (busy && collectionItems.length === 0 ? (
          <div className="mk-grid">
            {Array.from({ length: SKELETON_COUNT }, (_, index) => <PresetCardSkeleton key={index} />)}
          </div>
        ) : (
          <div className="mk-grid">
            {collectionItems.map((item) => (
              <div key={item.id} className="mk-grid__item mk-grid__item--append">
                <CollectionCard
                  id={item.id}
                  title={item.title}
                  description={item.description}
                  creatorHandle={item.creator.handle}
                  tags={item.tags}
                  createdAt={item.createdAt}
                  onClick={() => onNavigate(item.url)}
                />
              </div>
            ))}
          </div>
        ))}

        {tab === 'creators' && (busy && creatorItems.length === 0 ? (
          <div className="mk-creator-list">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="mk-card mk-creator-row" aria-hidden="true">
                <div className="mk-skeleton" style={{ width: 44, height: 44, borderRadius: '50%' }} />
                <div className="mk-creator-row__main" style={{ flex: 1 }}>
                  <div className="mk-skeleton" style={{ height: 14, width: '35%' }} />
                  <div className="mk-skeleton" style={{ height: 12, width: '60%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mk-creator-list">
            {creatorItems.map((item) => (
              <CreatorRow
                key={item.id}
                displayName={item.displayName}
                handle={item.handle}
                bio={item.bio}
                createdAt={item.createdAt}
                onClick={() => onNavigate(item.url)}
              />
            ))}
          </div>
        ))}

        {!busy && !message && tab === 'presets' && items.length === 0 && (
          <EmptyState
            icon={SearchX}
            title="No matching tones"
            hint="Try fewer filters or a different keyword."
          />
        )}
        {!busy && !message && tab === 'collections' && collectionItems.length === 0 && (
          <EmptyState
            icon={Layers}
            title="No matching collections"
            hint="Try a title, description, tag, or creator name."
          />
        )}
        {!busy && !message && tab === 'creators' && creatorItems.length === 0 && (
          <EmptyState
            icon={Users}
            title="No matching creators"
            hint="Try a handle or a display name."
          />
        )}

        {tab === 'presets' && nextCursor && (
          <div className="mk-browse__more">
            <button
              type="button"
              className="mk-btn mk-btn--secondary"
              disabled={busy}
              onClick={() => onNavigate(marketplaceSearchPath({ ...request, cursor: nextCursor }))}
            >Load more tones</button>
          </div>
        )}
        {tab === 'collections' && collectionCursor && (
          <div className="mk-browse__more">
            <button
              type="button"
              className="mk-btn mk-btn--secondary"
              disabled={busy}
              onClick={() => void runCollectionSearch(collectionText, collectionCursor, true)}
            >Load more collections</button>
          </div>
        )}
        {tab === 'creators' && creatorCursor && (
          <div className="mk-browse__more">
            <button
              type="button"
              className="mk-btn mk-btn--secondary"
              disabled={busy}
              onClick={() => void runCreatorSearch(creatorText, creatorCursor, true)}
            >Load more creators</button>
          </div>
        )}
      </div>
    </section>
  );
}
