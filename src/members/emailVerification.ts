export const MARKETPLACE_EMAIL_VERIFICATION_EVENT = 'marketplace:verify-email';

export interface MarketplaceEmailVerificationRequest {
  returnPath: string;
}

function sameSitePath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

export function parseMarketplaceEmailVerificationRequest(
  verificationUrl: string,
): MarketplaceEmailVerificationRequest | null {
  if (!verificationUrl.startsWith('/') || verificationUrl.startsWith('//')) return null;
  const url = new URL(verificationUrl, 'https://pedalboard.invalid');
  if (url.pathname !== '/login' || url.searchParams.get('verify') !== 'email') return null;
  const requestedReturnPath = url.searchParams.get('return');
  if (requestedReturnPath !== null && !sameSitePath(requestedReturnPath)) return null;
  return { returnPath: requestedReturnPath ?? '/' };
}

export function requestMarketplaceEmailVerification(verificationUrl: string): boolean {
  const detail = parseMarketplaceEmailVerificationRequest(verificationUrl);
  if (!detail) return false;
  window.dispatchEvent(new CustomEvent<MarketplaceEmailVerificationRequest>(
    MARKETPLACE_EMAIL_VERIFICATION_EVENT,
    { detail },
  ));
  return true;
}
