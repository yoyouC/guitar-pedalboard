export interface PublishedPresetRouteIdentity {
  presetId: string;
  revisionId: string | null;
}

const TONE_ROUTE = /^\/marketplace\/(?:tones|presets)\/([^/]+)(?:\/revisions\/([^/]+))?\/?$/;

export function publishedPresetRouteFromPath(
  pathname: string,
): PublishedPresetRouteIdentity | null {
  const match = TONE_ROUTE.exec(pathname);
  if (!match) return null;
  try {
    return {
      presetId: decodeURIComponent(match[1]),
      revisionId: match[2] ? decodeURIComponent(match[2]) : null,
    };
  } catch {
    return null;
  }
}

export function tonePath(presetId: string): string {
  return `/marketplace/tones/${encodeURIComponent(presetId)}`;
}

export function toneRevisionPath(presetId: string, revisionId: string): string {
  return `${tonePath(presetId)}/revisions/${encodeURIComponent(revisionId)}`;
}

export function canonicalMarketplacePath(pathname: string): string | null {
  if (pathname === '/marketplace/search' || pathname === '/marketplace/search/') return '/marketplace';
  if (!/^\/marketplace\/presets\//.test(pathname)) return null;
  const route = publishedPresetRouteFromPath(pathname);
  if (!route) return null;
  return route.revisionId
    ? toneRevisionPath(route.presetId, route.revisionId)
    : tonePath(route.presetId);
}

export function publishedPresetIdFromPath(pathname: string): string | null {
  const route = publishedPresetRouteFromPath(pathname);
  return route?.revisionId ? null : route?.presetId ?? null;
}

export function creatorHandleFromPath(pathname: string): string | null {
  const match = /^\/creators\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function presetCollectionIdFromPath(pathname: string): string | null {
  const match = /^\/marketplace\/collections\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
