import {
  DuplicateModerationReportError,
  ModerationAppealForbiddenError,
  ModerationTargetNotFoundError,
  ModerationTransitionError,
  MODERATION_ACTION_FAMILIES,
  type AuthorModerationCase,
  type MarketplaceModerationRepository,
  type ModerationAuditEntry,
  type ModerationContentTargetKind,
  type ModerationReportReason,
  type ModerationTargetKind,
} from './repository.ts';
import type { MarketplaceAccountExport } from '../../shared/account.ts';

interface Target {
  kind: ModerationTargetKind;
  id: string;
  creatorId: string;
  visibility: 'public' | 'unlisted' | 'withdrawn' | 'hidden';
}

interface Report {
  id: string;
  reporterMemberId: string;
  targetKind: ModerationTargetKind;
  targetId: string;
  reason: ModerationReportReason;
  details: string;
  status: 'open' | 'resolved';
  createdAt: string;
}

interface Notice {
  id: string;
  claimantName: string;
  claimantEmail: string;
  targetKind: ModerationTargetKind;
  targetId: string;
  rightsStatement: string;
  status: 'open' | 'resolved';
  createdAt: string;
}

interface Action extends ModerationAuditEntry {
  previousVisibility: Target['visibility'] | null;
}

interface Appeal {
  id: string;
  actionId: string;
  authorMemberId: string;
  statement: string;
  status: 'pending' | 'upheld' | 'rejected';
  createdAt: string;
}

export function createMemoryMarketplaceModerationRepository(input: {
  targets: Target[];
  setMemberStatus(memberId: string, status: 'active' | 'banned'): Promise<void>;
  setTargetVisibility(
    kind: ModerationContentTargetKind,
    targetId: string,
    visibility: Target['visibility'],
  ): Promise<void>;
  standingChanged(now: Date): Promise<void>;
  writeAllowed?(memberId: string): Promise<void>;
  contentRestorable?(memberId: string): Promise<void>;
}): MarketplaceModerationRepository & {
  exportForAccount(memberId: string): Promise<Pick<
    MarketplaceAccountExport['relationships'],
    'moderationReports' | 'moderationAppeals'
  >>;
  setAccountTargetVisibility(
    kind: ModerationContentTargetKind,
    targetId: string,
    visibility: Target['visibility'],
  ): Promise<void>;
} {
  const targets = new Map(input.targets.map((item) => [`${item.kind}\u0000${item.id}`, { ...item }]));
  const reports = new Map<string, Report>();
  const notices = new Map<string, Notice>();
  const actions = new Map<string, Action>();
  const appeals = new Map<string, Appeal>();
  const memberStatuses = new Map<string, 'active' | 'banned'>();
  const target = (kind: ModerationTargetKind, id: string) => {
    const item = targets.get(`${kind}\u0000${id}`);
    if (!item) throw new ModerationTargetNotFoundError();
    return item;
  };
  const audit = (value: Action) => actions.set(value.id, value);

  return {
    async submitReport(value) {
      await input.writeAllowed?.(value.reporterMemberId);
      const item = target(value.targetKind, value.targetId);
      if (item.visibility !== 'public' && item.visibility !== 'unlisted') {
        throw new ModerationTargetNotFoundError();
      }
      if ([...reports.values()].some((report) => (
        report.reporterMemberId === value.reporterMemberId
        && report.targetKind === value.targetKind && report.targetId === value.targetId
      ))) throw new DuplicateModerationReportError();
      reports.set(value.id, {
        id: value.id,
        reporterMemberId: value.reporterMemberId,
        targetKind: value.targetKind,
        targetId: value.targetId,
        reason: value.reason,
        details: value.details,
        status: 'open',
        createdAt: value.now.toISOString(),
      });
    },
    async submitInfringementNotice(value) {
      target(value.targetKind, value.targetId);
      notices.set(value.id, {
        id: value.id,
        claimantName: value.claimantName,
        claimantEmail: value.claimantEmail,
        targetKind: value.targetKind,
        targetId: value.targetId,
        rightsStatement: value.rightsStatement,
        status: 'open',
        createdAt: value.now.toISOString(),
      });
    },
    async listQueue() {
      return [
        ...[...reports.values()].filter((item) => item.status === 'open').map((item) => ({
          id: item.id, kind: 'report' as const,
          targetKind: item.targetKind, targetId: item.targetId,
          reason: item.reason, details: item.details,
          createdAt: item.createdAt, status: 'open' as const,
        })),
        ...[...notices.values()].filter((item) => item.status === 'open').map((item) => ({
          id: item.id, kind: 'notice' as const,
          targetKind: item.targetKind, targetId: item.targetId,
          claimantName: item.claimantName, claimantEmail: item.claimantEmail,
          reason: 'copyright' as const, details: item.rightsStatement,
          createdAt: item.createdAt, status: 'open' as const,
        })),
        ...[...appeals.values()].filter((item) => item.status === 'pending').map((item) => {
          const action = actions.get(item.actionId)!;
          return {
            id: item.id, kind: 'appeal' as const,
            targetKind: action.subjectKind as ModerationTargetKind,
            targetId: action.subjectId, details: item.statement,
            createdAt: item.createdAt, status: 'pending' as const,
          };
        }),
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    },
    async applyAction(value) {
      let previousVisibility: Target['visibility'] | null = null;
      const family = MODERATION_ACTION_FAMILIES[value.action];
      if (family === 'visibility') {
        if (value.subjectKind !== 'preset' && value.subjectKind !== 'collection') {
          throw new ModerationTransitionError();
        }
        const item = target(value.subjectKind, value.subjectId);
        if (value.action === 'hide') {
          if (item.visibility === 'hidden') throw new ModerationTransitionError();
          previousVisibility = item.visibility;
          await input.setTargetVisibility(value.subjectKind, value.subjectId, 'hidden');
          item.visibility = 'hidden';
        } else {
          await input.contentRestorable?.(item.creatorId);
          if (item.visibility !== 'hidden') throw new ModerationTransitionError();
          const hidden = [...actions.values()].reverse().find((action) => (
            action.action === 'hide' && action.subjectKind === value.subjectKind
            && action.subjectId === value.subjectId
          ));
          if (!hidden?.previousVisibility || hidden.previousVisibility === 'hidden') {
            throw new ModerationTransitionError();
          }
          await input.setTargetVisibility(
            value.subjectKind,
            value.subjectId,
            hidden.previousVisibility,
          );
          item.visibility = hidden.previousVisibility;
        }
      } else if (family === 'standing') {
        if (value.subjectKind !== 'member') throw new ModerationTransitionError();
        const current = memberStatuses.get(value.subjectId) ?? 'active';
        const expected = value.action === 'ban' ? 'active' : 'banned';
        if (current !== expected) throw new ModerationTransitionError();
        const next = value.action === 'ban' ? 'banned' : 'active';
        await input.setMemberStatus(value.subjectId, next);
        memberStatuses.set(value.subjectId, next);
        try {
          await input.standingChanged(value.now);
        } catch (cause) {
          await input.setMemberStatus(value.subjectId, current);
          memberStatuses.set(value.subjectId, current);
          await input.standingChanged(value.now);
          throw cause;
        }
      } else if (family === 'queue') {
        const queued = value.action === 'resolve_report'
          ? reports.get(value.subjectId)
          : notices.get(value.subjectId);
        if (!queued || queued.status !== 'open') throw new ModerationTransitionError();
        queued.status = 'resolved';
      } else {
        throw new ModerationTransitionError();
      }
      audit({
        id: value.id,
        actorAuthUserId: value.actorAuthUserId,
        action: value.action,
        subjectKind: value.subjectKind,
        subjectId: value.subjectId,
        reason: value.reason,
        createdAt: value.now.toISOString(),
        previousVisibility,
      });
    },
    async listAuthorCases(authorMemberId) {
      return [...actions.values()].flatMap((action): AuthorModerationCase[] => {
        if (action.action !== 'hide'
          || (action.subjectKind !== 'preset' && action.subjectKind !== 'collection')) return [];
        const item = target(action.subjectKind, action.subjectId);
        if (item.creatorId !== authorMemberId) return [];
        const appeal = [...appeals.values()].find((entry) => entry.actionId === action.id);
        return [{
          actionId: action.id,
          targetKind: action.subjectKind,
          targetId: action.subjectId,
          action: 'hide',
          reason: action.reason,
          createdAt: action.createdAt,
          appeal: appeal ? {
            id: appeal.id, status: appeal.status, statement: appeal.statement,
          } : null,
        }];
      }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async submitAppeal(value) {
      await input.writeAllowed?.(value.authorMemberId);
      const action = actions.get(value.actionId);
      if (!action || action.action !== 'hide'
        || (action.subjectKind !== 'preset' && action.subjectKind !== 'collection')
        || target(action.subjectKind, action.subjectId).creatorId !== value.authorMemberId) {
        throw new ModerationAppealForbiddenError();
      }
      if ([...appeals.values()].some((appeal) => appeal.actionId === value.actionId)) {
        throw new ModerationTransitionError();
      }
      appeals.set(value.id, {
        id: value.id,
        actionId: value.actionId,
        authorMemberId: value.authorMemberId,
        statement: value.statement,
        status: 'pending',
        createdAt: value.now.toISOString(),
      });
    },
    async resolveAppeal(value) {
      const appeal = appeals.get(value.appealId);
      if (!appeal || appeal.status !== 'pending') throw new ModerationTransitionError();
      const original = actions.get(appeal.actionId)!;
      const effective = [...actions.values()].reverse().find((action) => (
        (action.action === 'hide' || action.action === 'restore')
        && action.subjectKind === original.subjectKind
        && action.subjectId === original.subjectId
      ));
      if (value.outcome === 'upheld'
        && effective?.id === original.id
        && (original.subjectKind === 'preset' || original.subjectKind === 'collection')) {
        const item = target(original.subjectKind, original.subjectId);
        if (item.visibility === 'hidden' && original.previousVisibility) {
          await input.contentRestorable?.(item.creatorId);
          await input.setTargetVisibility(
            original.subjectKind,
            original.subjectId,
            original.previousVisibility,
          );
          item.visibility = original.previousVisibility;
        }
      }
      appeal.status = value.outcome;
      audit({
        id: value.id,
        actorAuthUserId: value.actorAuthUserId,
        action: `${value.outcome === 'upheld' ? 'uphold' : 'reject'}_appeal`,
        subjectKind: 'appeal',
        subjectId: value.appealId,
        reason: value.reason,
        createdAt: value.now.toISOString(),
        previousVisibility: null,
      });
    },
    async listAudit() {
      return [...actions.values()]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(({ previousVisibility: _previousVisibility, ...entry }) => ({ ...entry }));
    },
    async exportForAccount(memberId) {
      return {
        moderationReports: [...reports.values()]
          .filter((report) => report.reporterMemberId === memberId)
          .map((report) => ({
            id: report.id,
            targetKind: report.targetKind,
            targetId: report.targetId,
            reason: report.reason,
            details: report.details,
            status: report.status,
            createdAt: report.createdAt,
          })),
        moderationAppeals: [...appeals.values()]
          .filter((appeal) => appeal.authorMemberId === memberId)
          .map((appeal) => ({
            id: appeal.id,
            actionId: appeal.actionId,
            statement: appeal.statement,
            status: appeal.status,
            createdAt: appeal.createdAt,
          })),
      };
    },
    async setAccountTargetVisibility(kind, targetId, visibility) {
      const item = targets.get(`${kind}\u0000${targetId}`);
      if (item) item.visibility = visibility;
    },
  };
}
