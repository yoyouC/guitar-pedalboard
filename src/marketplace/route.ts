export function publishedPresetIdFromPath(pathname: string): string | null {
  const match = /^\/marketplace\/presets\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
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
