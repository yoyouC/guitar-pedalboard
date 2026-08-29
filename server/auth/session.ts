export interface AuthenticatedIdentity {
  authUserId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SessionVerifier {
  verify(request: Request): Promise<AuthenticatedIdentity | null>;
}
