export interface MemberProfile {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  handleChangedAt: string | null;
  nextHandleChangeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicCreatorProfile {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  publicWorksUrl: string;
}

export interface PublicCreatorWorkSummary {
  id: string;
  title: string;
  url: string;
}
