import {
  creatorHandleFromPath,
  presetCollectionIdFromPath,
  publishedPresetRouteFromPath,
} from '../marketplace/route.ts';

export type AppSection = 'pedalboard' | 'marketplace' | 'account' | 'unknown';

export type AppRoute =
  | { kind: 'pedalboard'; section: 'pedalboard' }
  | { kind: 'marketplace-search'; section: 'marketplace' }
  | { kind: 'published-preset'; section: 'marketplace' }
  | { kind: 'preset-collection'; section: 'marketplace' }
  | { kind: 'creator-profile'; section: 'marketplace' }
  | { kind: 'login'; section: 'account' }
  | { kind: 'library'; section: 'account' }
  | { kind: 'settings'; section: 'account' }
  | { kind: 'not-found'; section: 'unknown' };

function exactPath(pathname: string, expected: string): boolean {
  return pathname === expected || pathname === `${expected}/`;
}

/**
 * The application route is a presentation decision only. It never reads or mutates
 * rigStore, AudioEngine, authentication, or marketplace availability.
 */
export function resolveAppRoute(pathname: string): AppRoute {
  if (exactPath(pathname, '') || exactPath(pathname, '/')) {
    return { kind: 'pedalboard', section: 'pedalboard' };
  }
  // The callback boot owns the redirect. Keeping the instrument surface mounted
  // avoids flashing a marketplace/404 page while that asynchronous work settles.
  if (exactPath(pathname, '/tone3000/callback')) {
    return { kind: 'pedalboard', section: 'pedalboard' };
  }
  if (exactPath(pathname, '/marketplace/search')) {
    return { kind: 'marketplace-search', section: 'marketplace' };
  }
  if (publishedPresetRouteFromPath(pathname)) {
    return { kind: 'published-preset', section: 'marketplace' };
  }
  if (presetCollectionIdFromPath(pathname)) {
    return { kind: 'preset-collection', section: 'marketplace' };
  }
  if (creatorHandleFromPath(pathname)) {
    return { kind: 'creator-profile', section: 'marketplace' };
  }
  if (exactPath(pathname, '/login')) return { kind: 'login', section: 'account' };
  if (exactPath(pathname, '/library')) return { kind: 'library', section: 'account' };
  if (exactPath(pathname, '/settings')) return { kind: 'settings', section: 'account' };
  return { kind: 'not-found', section: 'unknown' };
}

