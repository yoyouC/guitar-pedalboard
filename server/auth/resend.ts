import type { EmailVerificationSender, MagicLinkSender } from './betterAuth.js';

export interface ResendMagicLinkSenderDependencies {
  apiKey: string;
  from: string;
  fetch?: typeof globalThis.fetch;
}

export type ResendEmailVerificationSenderDependencies = ResendMagicLinkSenderDependencies;

export function createResendMagicLinkSender({
  apiKey,
  from,
  fetch = globalThis.fetch,
}: ResendMagicLinkSenderDependencies): MagicLinkSender {
  return async ({ email, url }) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'guitar-pedalboard/1.0',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Sign in to Guitar Pedalboard',
        text: `Open this one-time link to sign in:\n\n${url}\n\nThis link expires in 5 minutes.`,
      }),
    });
    if (!response.ok) throw new Error(`Magic link delivery failed (${response.status})`);
  };
}

export function createResendEmailVerificationSender({
  apiKey,
  from,
  fetch = globalThis.fetch,
}: ResendEmailVerificationSenderDependencies): NonNullable<EmailVerificationSender> {
  return async ({ user, url }) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'guitar-pedalboard/1.0',
      },
      body: JSON.stringify({
        from,
        to: [user.email],
        subject: 'Verify your email for Guitar Pedalboard',
        text: `Open this one-time link to verify your email:\n\n${url}\n\nThis link expires in 5 minutes.`,
      }),
    });
    if (!response.ok) throw new Error(`Email verification delivery failed (${response.status})`);
  };
}
