import type { SessionVerifier } from './session.js';

interface BetterAuthSessionApi {
  getSession(input: { headers: Headers }): Promise<{
    session: { createdAt: Date | string };
    user: {
      id: string;
      email: string;
      emailVerified: boolean;
      name: string;
      image?: string | null;
    };
  } | null>;
}

export function createBetterAuthSessionVerifier(api: BetterAuthSessionApi): SessionVerifier {
  return {
    async verify(request) {
      const session = await api.getSession({ headers: request.headers });
      if (!session?.user) return null;
      return {
        authUserId: session.user.id,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        displayName: session.user.name.trim() || 'Guitar Player',
        avatarUrl: session.user.image ?? null,
        authenticatedAt: new Date(session.session.createdAt),
      };
    },
  };
}
