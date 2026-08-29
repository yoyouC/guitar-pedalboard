import {
  creatorRouteFromPath,
  presetCollectionIdFromPath,
  publishedPresetRouteFromPath,
} from '../marketplace/route.ts';

export type AppSection = 'pedalboard' | 'marketplace' | 'account' | 'unknown';

export type AppRoute =
  | { kind: 'pedalboard'; section: 'pedalboard' }
  | { kind: 'marketplace-search'; section: 'marketplace' }
  | { kind: 'marketplace-ranking'; section: 'marketplace' }
  | { kind: 'published-preset'; section: 'marketplace' }
  | { kind: 'preset-collection'; section: 'marketplace' }
  | { kind: 'creator-profile'; section: 'marketplace' }
  | { kind: 'infringement-notice'; section: 'marketplace' }
  | { kind: 'moderation-cases'; section: 'account' }
  | { kind: 'login'; section: 'account' }
  | { kind: 'library'; section: 'account' }
  | { kind: 'tone-manage'; section: 'account' }
  | { kind: 'collection-manage'; section: 'account' }
  | { kind: 'settings'; section: 'account' }
  | { kind: 'publish'; section: 'account' }
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
  if (exactPath(pathname, '/marketplace') || exactPath(pathname, '/marketplace/search')) {
    return { kind: 'marketplace-search', section: 'marketplace' };
  }
  if (
    exactPath(pathname, '/marketplace/popular')
    || exactPath(pathname, '/marketplace/trending')
    || exactPath(pathname, '/marketplace/latest')
  ) {
    return { kind: 'marketplace-ranking', section: 'marketplace' };
  }
  if (publishedPresetRouteFromPath(pathname)) {
    return { kind: 'published-preset', section: 'marketplace' };
  }
  if (presetCollectionIdFromPath(pathname)) {
    return { kind: 'preset-collection', section: 'marketplace' };
  }
  if (creatorRouteFromPath(pathname)) {
    return { kind: 'creator-profile', section: 'marketplace' };
  }
  if (exactPath(pathname, '/marketplace/infringement-notice')) {
    return { kind: 'infringement-notice', section: 'marketplace' };
  }
  if (exactPath(pathname, '/marketplace/me/moderation')) {
    return { kind: 'moderation-cases', section: 'account' };
  }
  if (exactPath(pathname, '/login')) return { kind: 'login', section: 'account' };
  if (exactPath(pathname, '/library') || exactPath(pathname, '/marketplace/me/likes')) {
    return { kind: 'library', section: 'account' };
  }
  if (/^\/library\/tones\/[^/]+\/?$/.test(pathname)) return { kind: 'tone-manage', section: 'account' };
  if (/^\/library\/collections\/[^/]+\/?$/.test(pathname)) return { kind: 'collection-manage', section: 'account' };
  if (exactPath(pathname, '/settings')) return { kind: 'settings', section: 'account' };
  if (exactPath(pathname, '/publish')) return { kind: 'publish', section: 'account' };
  return { kind: 'not-found', section: 'unknown' };
}
