export type MarketplaceTagStatus = 'active' | 'deprecated' | 'merged';

export interface ManagedMarketplaceTag {
  id: string;
  dimension: string;
  nameZh: string;
  nameEn: string;
  aliases: string[];
  status: MarketplaceTagStatus;
  mergedIntoId: string | null;
  presetCount: number;
  collectionCount: number;
}

interface AuditInput {
  auditId: string;
  actorAuthUserId: string;
  reason: string;
  now: Date;
}

type EditableTag = Pick<ManagedMarketplaceTag, 'dimension' | 'nameZh' | 'nameEn' | 'aliases'>;

export type MarketplaceTagCommand = AuditInput & (
  | { action: 'create'; tag: EditableTag & Pick<ManagedMarketplaceTag, 'id'> }
  | { action: 'edit'; tagId: string; tag: EditableTag }
  | { action: 'deprecate'; tagId: string }
  | { action: 'merge'; tagId: string; targetId: string }
);

export interface MarketplaceTagAuditEntry {
  id: string;
  actorAuthUserId: string;
  action: 'create_tag' | 'edit_tag' | 'deprecate_tag' | 'merge_tag';
  tagId: string;
  targetTagId: string | null;
  reason: string;
  createdAt: string;
}

export class MarketplaceTagConflictError extends Error {}
export class MarketplaceTagNotFoundError extends Error {}

/** Deep seam: commands own tag state changes, content migration, and audit atomically. */
export interface MarketplaceTagAdministrationRepository {
  list(): Promise<ManagedMarketplaceTag[]>;
  apply(command: MarketplaceTagCommand): Promise<ManagedMarketplaceTag>;
  listAudit(): Promise<MarketplaceTagAuditEntry[]>;
}
