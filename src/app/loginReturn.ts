export function safeLoginReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  try {
    const parsed = new URL(value, 'https://guitar-pedalboard.local');
    if (parsed.origin !== 'https://guitar-pedalboard.local') return '/';
    if (parsed.pathname === '/login') return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

export function loginReturnFromSearch(search: string): string {
  return safeLoginReturnPath(new URLSearchParams(search).get('return'));
}

