export interface MarketplaceAccountDeletion {
  status: 'pending';
  requestedAt: string;
  purgeAfter: string;
}

export interface MarketplaceAccountExport {
  formatVersion: 1;
  exportedAt: string;
  account: {
    email: string;
  };
  member: {
    id: string;
    handle: string;
    displayName: string;
    bio: string;
    avatarUrl: string | null;
    createdAt: string;
    updatedAt: string;
  };
  presets: Array<{
    id: string;
    title: string;
    description: string;
    visibility: string;
    tagIds: string[];
    source: { presetId: string; revisionId: string } | null;
    revisions: Array<{
      id: string;
      schemaVersion: number;
      resourceDependencies: unknown;
      derivedAttributes: unknown;
      rig: unknown;
      createdAt: string;
    }>;
    createdAt: string;
    updatedAt: string;
  }>;
  collections: Array<{
    id: string;
    title: string;
    description: string;
    visibility: string;
    tagIds: string[];
    items: Array<{ position: number; presetId: string; revisionId: string }>;
    createdAt: string;
    updatedAt: string;
  }>;
  relationships: {
    presetLikes: Array<{ presetId: string; createdAt: string }>;
    collectionLikes: Array<{ collectionId: string; createdAt: string }>;
    moderationReports: Array<{
      id: string;
      targetKind: string;
      targetId: string;
      reason: string;
      details: string;
      status: string;
      createdAt: string;
    }>;
    moderationAppeals: Array<{
      id: string;
      actionId: string;
      statement: string;
      status: string;
      createdAt: string;
    }>;
  };
}
