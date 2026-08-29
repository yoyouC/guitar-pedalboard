export interface AuthenticatedIdentity {
  authUserId: string;
  email: string;
  /** Omitted test adapters are treated as verified; production always supplies this fact. */
  emailVerified?: boolean;
  displayName: string;
  avatarUrl: string | null;
}

export interface SessionVerifier {
  verify(request: Request): Promise<AuthenticatedIdentity | null>;
}
