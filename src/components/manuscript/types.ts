// Shapes returned by the manuscript API routes — only the fields this UI consumes.

export type SectionKind =
  | "TITLE_PAGE"
  | "ABSTRACT"
  | "INTRODUCTION"
  | "METHODS"
  | "RESULTS"
  | "DISCUSSION"
  | "CONCLUSION"
  | "ACKNOWLEDGMENTS"
  | "CUSTOM";

export type SectionStatus = "DRAFT" | "IN_REVIEW" | "APPROVED";

export interface UserRef {
  id: string;
  name: string;
}

export interface SectionLock {
  userId: string;
  name: string;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  stale: boolean;
}

export interface SectionSummary {
  id: string;
  title: string;
  kind: SectionKind;
  order: number;
  status: SectionStatus;
  wordCount: number;
  version: number;
  updatedAt: string;
  assignee: UserRef | null;
  lock: SectionLock | null;
  openCommentCount: number;
  canEdit: boolean;
}

export interface ManuscriptView {
  id: string;
  title: string;
  citationStyleId: string | null;
  canEditAny: boolean;
  canManage: boolean;
  canComment: boolean;
  isPicoSubProject: boolean;
  usesPicoDefaultSections: boolean;
  canResetToPicoDefaults: boolean;
  sections: SectionSummary[];
}

export interface SectionDetail {
  id: string;
  title: string;
  kind: SectionKind;
  status: SectionStatus;
  content: unknown;
  contentText: string;
  wordCount: number;
  version: number;
  assignee: UserRef | null;
  lock: SectionLock | null;
  canEdit: boolean;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  origin: "EXPLICIT" | "LOCK_RELEASE" | "TAKEOVER" | "RESTORE";
  note: string | null;
  wordCount: number;
  createdAt: string;
  savedBy: UserRef;
}

export interface CommentView {
  id: string;
  body: string;
  quotedText: string | null;
  status: "OPEN" | "RESOLVED";
  createdAt: string;
  author: UserRef;
  resolvedBy?: UserRef | null;
  mentions: string[];
  replies?: CommentView[];
}

export interface CiteMapResponse {
  styleId: string;
  numeric: boolean;
  markers: Record<string, string>;
  orderedReferenceIds: string[];
  bibliography: { referenceId: string; index: number; html: string; text: string }[];
}

export interface MemberRef {
  userId: string;
  user: { id: string; name: string; email: string };
  status: string;
}

export const SECTION_STATUS_LABEL: Record<SectionStatus, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  APPROVED: "Approved",
};

export const SECTION_STATUS_VARIANT: Record<SectionStatus, "muted" | "maybe" | "include"> = {
  DRAFT: "muted",
  IN_REVIEW: "maybe",
  APPROVED: "include",
};

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
