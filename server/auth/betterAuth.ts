import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { magicLink, type MagicLinkOptions } from 'better-auth/plugins/magic-link';

export type MagicLinkSender = MagicLinkOptions['sendMagicLink'];

export type GoogleProviderOptions = NonNullable<
  NonNullable<BetterAuthOptions['socialProviders']>['google']
>;

export interface PlatformAuthDependencies {
  baseURL: string;
  secret: string;
  database?: BetterAuthOptions['database'];
  sendMagicLink: MagicLinkSender;
  google?: GoogleProviderOptions;
  trustedOrigins?: string[];
}

export function createPlatformAuthOptions({
  baseURL,
  secret,
  database,
  sendMagicLink,
  google,
  trustedOrigins,
}: PlatformAuthDependencies): BetterAuthOptions {
  return {
    appName: 'Guitar Pedalboard',
    baseURL,
    basePath: '/api/auth',
    secret,
    ...(trustedOrigins ? { trustedOrigins } : {}),
    ...(database ? { database } : {}),
    emailAndPassword: { enabled: false },
    user: { modelName: 'marketplace_auth_users' },
    session: { modelName: 'marketplace_auth_sessions' },
    account: {
      modelName: 'marketplace_auth_accounts',
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
      },
    },
    verification: { modelName: 'marketplace_auth_verifications' },
    emailVerification: {
      expiresIn: 5 * 60,
      sendVerificationEmail: async ({ user, url, token }) => {
        await sendMagicLink({ email: user.email, url, token });
      },
    },
    plugins: [
      magicLink({
        sendMagicLink,
        expiresIn: 5 * 60,
        storeToken: 'hashed',
      }),
    ],
    ...(google ? {
      socialProviders: {
        google,
      },
    } : {}),
  };
}

export function createPlatformAuth(dependencies: PlatformAuthDependencies) {
  return betterAuth(createPlatformAuthOptions(dependencies));
}

export type PlatformAuth = ReturnType<typeof createPlatformAuth>;
