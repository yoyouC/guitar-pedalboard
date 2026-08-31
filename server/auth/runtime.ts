import type { Pool } from 'pg';
import { createPlatformAuth } from './betterAuth.js';
import {
  createResendEmailVerificationSender,
  createResendMagicLinkSender,
} from './resend.js';

export class AuthConfigurationError extends Error {}

export function authenticationBaseURL(
  environment: Record<string, string | undefined> = process.env,
): URL {
  const configured = environment.BETTER_AUTH_URL
    ?? (environment.VERCEL_ENV === 'preview' && environment.VERCEL_URL
      ? `https://${environment.VERCEL_URL}`
      : undefined);
  if (!configured) throw new AuthConfigurationError('BETTER_AUTH_URL is required');
  try {
    const url = new URL(configured);
    if (url.username || url.password || url.search || url.hash) throw new Error('invalid');
    url.pathname = '/';
    return url;
  } catch {
    throw new AuthConfigurationError('BETTER_AUTH_URL is invalid');
  }
}

export function createRuntimeAuth(database: Pool) {
  const baseURL = authenticationBaseURL();
  const secret = process.env.BETTER_AUTH_SECRET;
  const resendApiKey = process.env.RESEND_API_KEY;
  const emailFrom = process.env.AUTH_EMAIL_FROM;
  if (!secret || secret.length < 32 || !resendApiKey || !emailFrom) {
    throw new AuthConfigurationError('Authentication environment is incomplete');
  }

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new AuthConfigurationError('Google authentication environment is incomplete');
  }

  return createPlatformAuth({
    baseURL: baseURL.origin,
    secret,
    database,
    sendMagicLink: createResendMagicLinkSender({
      apiKey: resendApiKey,
      from: emailFrom,
    }),
    sendEmailVerification: createResendEmailVerificationSender({
      apiKey: resendApiKey,
      from: emailFrom,
    }),
    ...(googleClientId && googleClientSecret ? {
      google: { clientId: googleClientId, clientSecret: googleClientSecret },
    } : {}),
  });
}
