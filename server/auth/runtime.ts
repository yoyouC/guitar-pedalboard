import type { Pool } from 'pg';
import { createPlatformAuth } from './betterAuth.ts';
import {
  createResendEmailVerificationSender,
  createResendMagicLinkSender,
} from './resend.ts';

export class AuthConfigurationError extends Error {}

export function authenticationBaseURL(): URL {
  const configured = process.env.BETTER_AUTH_URL;
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
