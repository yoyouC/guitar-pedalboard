export function publishedPresetIdFromPath(pathname: string): string | null {
  const match = /^\/marketplace\/presets\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
