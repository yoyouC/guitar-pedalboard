import type { SessionVerifier } from '../auth/session.js';
import type { MemberRecord, MemberRepository } from '../members/repository.js';
import {
  communityWriteDenied,
  communityWriteErrorResponse,
  unverifiedEmailWriteDenied,
} from '../members/communityWriteApi.js';
import {
  DuplicateModerationReportError,
  ModerationAppealForbiddenError,
  ModerationTargetNotFoundError,
  ModerationTransitionError,
  type MarketplaceModerationRepository,
  MODERATION_ACTION_SUBJECT_KINDS,
  type ModerationActionCommand,
  type ModerationContentTargetKind,
  type ModerationReportReason,
  type ModerationTargetKind,
} from './repository.js';
import { marketplaceWriteLimitDenied, type MarketplaceWriteLimiter } from '../abuse/writeLimiter.js';

const REPORTS_PATH = '/api/marketplace/reports';
const NOTICES_PATH = '/api/marketplace/infringement-notices';
const MY_CASES_PATH = '/api/marketplace/me/moderation';
const APPEALS_PATH = '/api/marketplace/moderation/appeals';
const ADMIN_QUEUE_PATH = '/api/marketplace/admin/moderation/queue';
const ADMIN_ACTIONS_PATH = '/api/marketplace/admin/moderation/actions';
const ADMIN_APPEALS_PATH = '/api/marketplace/admin/moderation/appeals';
const ADMIN_AUDIT_PATH = '/api/marketplace/admin/moderation/audit';

export interface MarketplaceModerationApi {
  fetch(request: Request): Promise<Response>;
}

export function createMarketplaceModerationApi(input: {
  repository: MarketplaceModerationRepository;
  sessions: SessionVerifier;
  members: MemberRepository;
  adminAuthUserIds: ReadonlySet<string>;
  now(): Date;
  createId(): string;
  createMemberId(): string;
  createHandleSuffix(): string;
  writeLimiter?: MarketplaceWriteLimiter;
}): MarketplaceModerationApi {
  const member = async (request: Request, verificationReturnPath?: string): Promise<MemberRecord> => {
    const identity = await input.sessions.verify(request);
    if (!identity) throw new ApiError(401, 'authentication_required', 'Authentication required');
    if (verificationReturnPath) {
      const denied = unverifiedEmailWriteDenied(identity, verificationReturnPath);
      if (denied) throw new ResponseError(denied);
    }
    const current = await input.members.findOrCreateForIdentity({
      id: input.createMemberId(), identity,
      handle: `player-${input.createHandleSuffix()}`, now: input.now(),
    });
    return current;
  };
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
        if (request.method === 'POST' && path === REPORTS_PATH) {
          const current = await member(request, '/marketplace');
          const denied = communityWriteDenied(current);
          if (denied) return denied;
          const body = reportBody(await readBody(request));
          if (!body) return invalid('invalid_report', 'Report is invalid');
          const now = input.now();
          const limited = await marketplaceWriteLimitDenied({
            limiter: input.writeLimiter, operation: 'report', memberId: current.id,
            request, now,
          });
          if (limited) return limited;
          const id = input.createId();
          await input.repository.submitReport({
            id, reporterMemberId: current.id, ...body, now,
          });
          return Response.json({ report: { id } }, { status: 201 });
        }
        if (request.method === 'POST' && path === NOTICES_PATH) {
          const body = noticeBody(await readBody(request));
          if (!body) return invalid('invalid_infringement_notice', 'Infringement notice is invalid');
          await input.repository.submitInfringementNotice({ id: input.createId(), ...body, now: input.now() });
          return new Response(null, { status: 201 });
        }
        if (request.method === 'GET' && path === MY_CASES_PATH) {
          const current = await member(request);
          return Response.json({ cases: await input.repository.listAuthorCases(current.id) });
        }
        if (request.method === 'POST' && path === APPEALS_PATH) {
          const current = await member(request);
          const denied = communityWriteDenied(current);
          if (denied) return denied;
          const body = appealBody(await readBody(request));
          if (!body) return invalid('invalid_appeal', 'Appeal is invalid');
          await input.repository.submitAppeal({
            id: input.createId(), authorMemberId: current.id, ...body, now: input.now(),
          });
          return new Response(null, { status: 201 });
        }
        if (request.method === 'GET' && path === ADMIN_QUEUE_PATH) {
          await admin(request);
          return Response.json({ items: await input.repository.listQueue() });
        }
        if (request.method === 'GET' && path === ADMIN_AUDIT_PATH) {
          await admin(request);
          return Response.json({ entries: await input.repository.listAudit() });
        }
        if (request.method === 'POST' && path === ADMIN_ACTIONS_PATH) {
          const identity = await admin(request);
          const body = actionBody(await readBody(request));
          if (!body) return invalid('invalid_moderation_action', 'Moderation action is invalid');
          await input.repository.applyAction({
            id: input.createId(), actorAuthUserId: identity.authUserId, ...body, now: input.now(),
          });
          return new Response(null, { status: 204 });
        }
        if (request.method === 'POST' && path === ADMIN_APPEALS_PATH) {
          const identity = await admin(request);
          const body = appealResolutionBody(await readBody(request));
          if (!body) return invalid('invalid_appeal_resolution', 'Appeal resolution is invalid');
          await input.repository.resolveAppeal({
            id: input.createId(), actorAuthUserId: identity.authUserId, ...body, now: input.now(),
          });
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      } catch (cause) {
        if (cause instanceof ResponseError) return cause.response;
        const denied = communityWriteErrorResponse(cause);
        if (denied) return denied;
        if (cause instanceof ApiError) return error(cause.status, cause.code, cause.message);
        if (cause instanceof DuplicateModerationReportError) {
          return error(409, 'duplicate_report', 'This target was already reported');
        }
        if (cause instanceof ModerationTargetNotFoundError) {
          return error(404, 'moderation_target_not_found', 'Moderation target not found');
        }
        if (cause instanceof ModerationAppealForbiddenError) {
          return error(403, 'appeal_forbidden', 'This moderation action cannot be appealed');
        }
        if (cause instanceof ModerationTransitionError) {
          return error(409, 'moderation_transition_conflict', 'Moderation state has changed');
        }
        return error(503, 'marketplace_unavailable', 'Marketplace is temporarily unavailable');
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

class ResponseError extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super('Request rejected with a prepared response');
    this.response = response;
  }
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function invalid(code: string, message: string): Response {
  return error(400, code, message);
}

async function readBody(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function targetKind(value: unknown): value is ModerationTargetKind {
  return value === 'preset' || value === 'collection' || value === 'member';
}

function contentTargetKind(value: unknown): value is ModerationContentTargetKind {
  return value === 'preset' || value === 'collection';
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length >= minimum && value.length <= maximum;
}

function reportBody(value: unknown) {
  const body = record(value);
  const reasons: ModerationReportReason[] = ['copyright', 'spam', 'impersonation', 'inappropriate'];
  if (!body || !exactKeys(body, ['targetKind', 'targetId', 'reason', 'details'])
    || !targetKind(body.targetKind) || !text(body.targetId, 1, 200)
    || !reasons.includes(body.reason as ModerationReportReason) || !text(body.details, 1, 2000)) return null;
  return {
    targetKind: body.targetKind,
    targetId: body.targetId.trim(),
    reason: body.reason as ModerationReportReason,
    details: body.details.trim(),
  };
}

function noticeBody(value: unknown) {
  const body = record(value);
  if (!body || !exactKeys(body, [
    'claimantName', 'claimantEmail', 'targetKind', 'targetId', 'rightsStatement', 'goodFaith',
  ]) || !text(body.claimantName, 1, 160) || !text(body.claimantEmail, 3, 320)
    || !/^\S+@\S+\.\S+$/.test(body.claimantEmail) || !contentTargetKind(body.targetKind)
    || !text(body.targetId, 1, 200) || !text(body.rightsStatement, 20, 4000)
    || body.goodFaith !== true) return null;
  return {
    claimantName: body.claimantName.trim(), claimantEmail: body.claimantEmail.trim(),
    targetKind: body.targetKind, targetId: body.targetId.trim(),
    rightsStatement: body.rightsStatement.trim(),
  };
}

function appealBody(value: unknown) {
  const body = record(value);
  if (!body || !exactKeys(body, ['actionId', 'statement'])
    || !text(body.actionId, 1, 200) || !text(body.statement, 1, 2000)) return null;
  return { actionId: body.actionId.trim(), statement: body.statement.trim() };
}

function actionBody(value: unknown) {
  const body = record(value);
  const action = typeof body?.action === 'string'
    && body.action in MODERATION_ACTION_SUBJECT_KINDS
    ? body.action as keyof typeof MODERATION_ACTION_SUBJECT_KINDS
    : null;
  const subjectKind = typeof body?.subjectKind === 'string' ? body.subjectKind : '';
  if (!body || !exactKeys(body, ['action', 'subjectKind', 'subjectId', 'reason'])
    || !action
    || !(MODERATION_ACTION_SUBJECT_KINDS[action] as readonly string[]).includes(subjectKind)
    || !text(body.subjectId, 1, 200) || !text(body.reason, 1, 2000)) return null;
  return {
    action,
    subjectKind,
    subjectId: body.subjectId.trim(), reason: body.reason.trim(),
  } as ModerationActionCommand;
}

function appealResolutionBody(value: unknown) {
  const body = record(value);
  if (!body || !exactKeys(body, ['appealId', 'outcome', 'reason'])
    || !text(body.appealId, 1, 200) || !['upheld', 'rejected'].includes(String(body.outcome))
    || !text(body.reason, 1, 2000)) return null;
  return {
    appealId: body.appealId.trim(),
    outcome: body.outcome as 'upheld' | 'rejected',
    reason: body.reason.trim(),
  };
}
