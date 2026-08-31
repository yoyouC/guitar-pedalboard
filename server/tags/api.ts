import type { SessionVerifier } from '../auth/session.js';
import type { MarketplaceTagAdministrationRepository } from './repository.js';
import { MarketplaceTagConflictError, MarketplaceTagNotFoundError } from './repository.js';

const TAGS_PATH = '/api/marketplace/admin/tags';
const AUDIT_PATH = `${TAGS_PATH}/audit`;

export interface MarketplaceTagAdministrationApi {
  fetch(request: Request): Promise<Response>;
}

export function createMarketplaceTagAdministrationApi(input: {
  repository: MarketplaceTagAdministrationRepository;
  sessions: SessionVerifier;
  adminAuthUserIds: ReadonlySet<string>;
  now(): Date;
  createAuditId(): string;
}): MarketplaceTagAdministrationApi {
  const admin = async (request: Request) => {
    const identity = await input.sessions.verify(request);
    if (!identity) throw new ApiError(401, 'authentication_required', 'Authentication required');
    if (!input.adminAuthUserIds.has(identity.authUserId)) {
      throw new ApiError(403, 'administrator_required', 'Administrator access required');
    }
    return identity;
  };
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      try {
        const identity = await admin(request);
        if (path === TAGS_PATH && request.method === 'GET') {
          return Response.json({ tags: await input.repository.list() });
        }
        if (path === AUDIT_PATH && request.method === 'GET') {
          return Response.json({ entries: await input.repository.listAudit() });
        }
        if (path === TAGS_PATH && request.method === 'POST') {
          const body = createBody(await readBody(request));
          if (!body) return failure(400, 'invalid_tag', 'Tag is invalid');
          const tag = await input.repository.apply({
            action: 'create', tag: body.tag, reason: body.reason,
            auditId: input.createAuditId(), actorAuthUserId: identity.authUserId, now: input.now(),
          });
          return Response.json({ tag }, { status: 201 });
        }
        const deprecate = path.match(/^\/api\/marketplace\/admin\/tags\/([^/]+)\/deprecate$/);
        if (deprecate && request.method === 'POST') {
          const reason = reasonBody(await readBody(request));
          if (!reason) return failure(400, 'invalid_tag_deprecation', 'Tag deprecation is invalid');
          const tag = await input.repository.apply({
            action: 'deprecate', tagId: decodeURIComponent(deprecate[1]), reason,
            auditId: input.createAuditId(), actorAuthUserId: identity.authUserId, now: input.now(),
          });
          return Response.json({ tag });
        }
        const merge = path.match(/^\/api\/marketplace\/admin\/tags\/([^/]+)\/merge$/);
        if (merge && request.method === 'POST') {
          const body = mergeBody(await readBody(request));
          if (!body) return failure(400, 'invalid_tag_merge', 'Tag merge is invalid');
          const tag = await input.repository.apply({
            action: 'merge', tagId: decodeURIComponent(merge[1]), targetId: body.targetId,
            reason: body.reason, auditId: input.createAuditId(),
            actorAuthUserId: identity.authUserId, now: input.now(),
          });
          return Response.json({ tag });
        }
        const edit = path.match(/^\/api\/marketplace\/admin\/tags\/([^/]+)$/);
        if (edit && request.method === 'PATCH') {
          const body = editBody(await readBody(request));
          if (!body) return failure(400, 'invalid_tag', 'Tag is invalid');
          const tag = await input.repository.apply({
            action: 'edit', tagId: decodeURIComponent(edit[1]), tag: body.tag, reason: body.reason,
            auditId: input.createAuditId(), actorAuthUserId: identity.authUserId, now: input.now(),
          });
          return Response.json({ tag });
        }
        return new Response(null, { status: 404 });
      } catch (cause) {
        if (cause instanceof ApiError) return failure(cause.status, cause.code, cause.message);
        if (cause instanceof MarketplaceTagConflictError) return failure(409, 'tag_conflict', 'Tag state conflicts');
        if (cause instanceof MarketplaceTagNotFoundError) return failure(404, 'tag_not_found', 'Tag not found');
        return failure(503, 'marketplace_unavailable', 'Marketplace is temporarily unavailable');
      }
    },
  };
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function readBody(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

function createBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 6
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(body.id))
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(body.dimension))
    || !text(body.nameZh, 1, 80) || !text(body.nameEn, 1, 80)
    || !Array.isArray(body.aliases) || body.aliases.length > 20
    || body.aliases.some((alias) => !text(alias, 1, 80))
    || new Set(body.aliases.map((alias) => String(alias).trim().normalize('NFKC').toLocaleLowerCase())).size !== body.aliases.length
    || !text(body.reason, 1, 2000)) return null;
  return {
    tag: {
      id: String(body.id), dimension: String(body.dimension),
      nameZh: String(body.nameZh).trim(), nameEn: String(body.nameEn).trim(),
      aliases: body.aliases.map((alias) => String(alias).trim()),
    },
    reason: String(body.reason).trim(),
  };
}

function editBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 5
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(body.dimension))
    || !text(body.nameZh, 1, 80) || !text(body.nameEn, 1, 80)
    || !Array.isArray(body.aliases) || body.aliases.length > 20
    || body.aliases.some((alias) => !text(alias, 1, 80))
    || new Set(body.aliases.map((alias) => String(alias).trim().normalize('NFKC').toLocaleLowerCase())).size !== body.aliases.length
    || !text(body.reason, 1, 2000)) return null;
  return {
    tag: {
      dimension: String(body.dimension), nameZh: String(body.nameZh).trim(),
      nameEn: String(body.nameEn).trim(), aliases: body.aliases.map((alias) => String(alias).trim()),
    },
    reason: String(body.reason).trim(),
  };
}

function reasonBody(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && text(body.reason, 1, 2000)
    ? body.reason.trim()
    : null;
}

function mergeBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 2
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(body.targetId))
    && text(body.reason, 1, 2000)
    ? { targetId: String(body.targetId), reason: body.reason.trim() }
    : null;
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length >= minimum && value.length <= maximum;
}
