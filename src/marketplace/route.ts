export interface PublishedPresetRouteIdentity {
  presetId: string;
  revisionId: string | null;
}

export function publishedPresetRouteFromPath(
  pathname: string,
): PublishedPresetRouteIdentity | null {
  const match = /^\/marketplace\/presets\/([^/]+)(?:\/revisions\/([^/]+))?\/?$/.exec(pathname);
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
