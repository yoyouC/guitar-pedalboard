import type {
  MemberProfile,
  PublicCreatorProfile,
  PublicCreatorWorkSummary,
} from '../../shared/members.ts';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class MemberClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MEMBER_KEYS = [
  'avatarUrl',
  'bio',
  'createdAt',
  'displayName',
  'handle',
  'handleChangedAt',
  'id',
  'nextHandleChangeAt',
  'updatedAt',
].sort();

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseMember(value: unknown): MemberProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(MEMBER_KEYS)) return null;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.handle !== 'string'
    || typeof candidate.displayName !== 'string'
    || typeof candidate.bio !== 'string'
    || !isNullableString(candidate.avatarUrl)
    || !isNullableString(candidate.handleChangedAt)
    || !isNullableString(candidate.nextHandleChangeAt)
    || typeof candidate.createdAt !== 'string'
    || typeof candidate.updatedAt !== 'string'
  ) return null;
  return candidate as unknown as MemberProfile;
}

async function responseError(response: Response, fallbackCode: string): Promise<MemberClientError> {
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === 'string' && typeof body.error.message === 'string') {
      return new MemberClientError(body.error.code, body.error.message);
    }
  } catch {
    // Stable fallback below owns malformed error bodies.
  }
  return new MemberClientError(fallbackCode, 'Member service is unavailable');
}

export async function fetchCurrentMember(fetch: FetchLike = globalThis.fetch): Promise<MemberProfile> {
  const response = await fetch('/api/marketplace/me', { headers: { accept: 'application/json' } });
  if (response.status === 401) throw new MemberClientError('authentication_required', '请先登录');
  if (!response.ok) throw await responseError(response, 'member_service_unavailable');
  const body = await response.json() as { member?: unknown };
  const member = parseMember(body.member);
  if (!member) throw new MemberClientError('invalid_member_response', '成员资料响应无效');
  return member;
}

export async function requestMagicLink(
  email: string,
  callbackURL: string,
  fetch: FetchLike = globalThis.fetch,
): Promise<void> {
  const response = await fetch('/api/auth/sign-in/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, callbackURL }),
  });
  if (!response.ok) throw await responseError(response, 'authentication_unavailable');
}

export async function updateMemberProfile(
  update: { handle?: string; displayName?: string; bio?: string; expectedUpdatedAt: string },
  fetch: FetchLike = globalThis.fetch,
): Promise<MemberProfile> {
  const response = await fetch('/api/marketplace/me/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) throw await responseError(response, 'member_service_unavailable');
  const body = await response.json() as { member?: unknown };
  const member = parseMember(body.member);
  if (!member) throw new MemberClientError('invalid_member_response', '成员资料响应无效');
  return member;
}

export async function beginGoogleAuth(
  mode: 'sign-in' | 'link',
  callbackURL: string,
  fetch: FetchLike = globalThis.fetch,
): Promise<string> {
  const endpoint = mode === 'link' ? '/api/auth/link-social' : '/api/auth/sign-in/social';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'google', callbackURL, disableRedirect: true }),
  });
  if (!response.ok) throw await responseError(response, 'authentication_unavailable');
  const body = await response.json() as { url?: unknown };
  if (typeof body.url !== 'string') {
    throw new MemberClientError('invalid_auth_response', '认证响应无效');
  }
  return body.url;
}

export async function signOut(fetch: FetchLike = globalThis.fetch): Promise<void> {
  const response = await fetch('/api/auth/sign-out', { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'authentication_unavailable');
}

export async function fetchPublicCreator(
  handle: string,
  fetch: FetchLike = globalThis.fetch,
): Promise<PublicCreatorProfile> {
  return fetchPublicCreatorAt(`/api/marketplace/creators/${encodeURIComponent(handle)}`, fetch);
}

export async function fetchPublicCreatorById(
  memberId: string,
  fetch: FetchLike = globalThis.fetch,
): Promise<PublicCreatorProfile> {
  return fetchPublicCreatorAt(
    `/api/marketplace/creators/id/${encodeURIComponent(memberId)}`,
    fetch,
  );
}

async function fetchPublicCreatorAt(
  path: string,
  fetch: FetchLike,
): Promise<PublicCreatorProfile> {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw await responseError(response, 'creator_unavailable');
  const body = await response.json() as { creator?: unknown };
  const creator = body.creator;
  if (!creator || typeof creator !== 'object' || Array.isArray(creator)) {
    throw new MemberClientError('invalid_creator_response', '创作者资料响应无效');
  }
  const value = creator as Record<string, unknown>;
  const keys = ['avatarUrl', 'bio', 'displayName', 'handle', 'id', 'publicWorksUrl'].sort();
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
    || typeof value.id !== 'string'
    || typeof value.handle !== 'string'
    || typeof value.displayName !== 'string'
    || typeof value.bio !== 'string'
    || !isNullableString(value.avatarUrl)
    || typeof value.publicWorksUrl !== 'string'
  ) throw new MemberClientError('invalid_creator_response', '创作者资料响应无效');
  return value as unknown as PublicCreatorProfile;
}

export async function fetchPublicCreatorWorks(
  handle: string,
  fetch: FetchLike = globalThis.fetch,
): Promise<PublicCreatorWorkSummary[]> {
  return fetchPublicCreatorWorksAt(
    `/api/marketplace/creators/${encodeURIComponent(handle)}/presets`,
    fetch,
  );
}

export async function fetchPublicCreatorWorksById(
  memberId: string,
  fetch: FetchLike = globalThis.fetch,
): Promise<PublicCreatorWorkSummary[]> {
  return fetchPublicCreatorWorksAt(
    `/api/marketplace/creators/id/${encodeURIComponent(memberId)}/presets`,
    fetch,
  );
}

async function fetchPublicCreatorWorksAt(
  path: string,
  fetch: FetchLike,
): Promise<PublicCreatorWorkSummary[]> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw await responseError(response, 'creator_unavailable');
  const body = await response.json() as { presets?: unknown };
  if (!Array.isArray(body.presets) || body.presets.some((preset) => {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return true;
    const value = preset as Record<string, unknown>;
    return JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['id', 'title', 'url'])
      || typeof value.id !== 'string'
      || typeof value.title !== 'string'
      || typeof value.url !== 'string';
  })) throw new MemberClientError('invalid_creator_response', '创作者作品响应无效');
  return body.presets as PublicCreatorWorkSummary[];
}
