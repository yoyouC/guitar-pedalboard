import type {
  MarketplaceAuthorModerationCase,
  MarketplaceModerationReportReason,
  MarketplaceModerationTargetKind,
} from '../../shared/marketplace.ts';

export type ModerationTargetKind = MarketplaceModerationTargetKind;
export type ModerationReportReason = MarketplaceModerationReportReason;
export const MODERATION_ACTION_SUBJECT_KINDS = {
  hide: ['preset', 'collection'],
  restore: ['preset', 'collection'],
  ban: ['member'],
  unban: ['member'],
  resolve_report: ['report'],
  resolve_notice: ['notice'],
} as const;
export type ModerationActionName = keyof typeof MODERATION_ACTION_SUBJECT_KINDS;
export const MODERATION_ACTION_FAMILIES: Record<ModerationActionName, 'visibility' | 'standing' | 'queue'> = {
  hide: 'visibility',
  restore: 'visibility',
  ban: 'standing',
  unban: 'standing',
  resolve_report: 'queue',
  resolve_notice: 'queue',
};
export type ModerationActionCommand = {
  [Action in ModerationActionName]: {
    action: Action;
    subjectKind: (typeof MODERATION_ACTION_SUBJECT_KINDS)[Action][number];
    subjectId: string;
    reason: string;
  }
}[ModerationActionName];

export interface ModerationQueueItem {
  id: string;
  kind: 'report' | 'notice' | 'appeal';
  targetKind?: ModerationTargetKind;
  targetId?: string;
  reason?: ModerationReportReason;
  claimantName?: string;
  claimantEmail?: string;
  details: string;
  createdAt: string;
  status: 'open' | 'pending';
}

export interface ModerationAuditEntry {
  id: string;
  actorAuthUserId: string;
  action: string;
  subjectKind: string;
  subjectId: string;
  reason: string;
  createdAt: string;
}

export type AuthorModerationCase = MarketplaceAuthorModerationCase;

export class ModerationTargetNotFoundError extends Error {}
export class DuplicateModerationReportError extends Error {}
export class ModerationTransitionError extends Error {}
export class ModerationAppealForbiddenError extends Error {}

export interface MarketplaceModerationRepository {
  submitReport(input: {
    id: string;
    reporterMemberId: string;
    targetKind: ModerationTargetKind;
    targetId: string;
    reason: ModerationReportReason;
    details: string;
    now: Date;
  }): Promise<void>;
  submitInfringementNotice(input: {
    id: string;
    claimantName: string;
    claimantEmail: string;
    targetKind: ModerationTargetKind;
    targetId: string;
    rightsStatement: string;
    now: Date;
  }): Promise<void>;
  listQueue(): Promise<ModerationQueueItem[]>;
  applyAction(input: {
    id: string;
    actorAuthUserId: string;
    now: Date;
  } & ModerationActionCommand): Promise<void>;
  listAuthorCases(authorMemberId: string): Promise<AuthorModerationCase[]>;
  submitAppeal(input: {
    id: string;
    actionId: string;
    authorMemberId: string;
    statement: string;
    now: Date;
  }): Promise<void>;
  resolveAppeal(input: {
    id: string;
    appealId: string;
    actorAuthUserId: string;
    outcome: 'upheld' | 'rejected';
    reason: string;
    now: Date;
  }): Promise<void>;
  listAudit(): Promise<ModerationAuditEntry[]>;
}
